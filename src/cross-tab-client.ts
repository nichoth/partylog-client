import { nanoid } from 'nanoid'
import { PartySocket } from 'partysocket'
import { createNanoEvents } from 'nanoevents'
import { IndexedStore } from './store.js'
import {
    Metadata,
    DeserializedSeq,
    ProtocolActions,
    EncryptedMessage,
    HelloAction
} from './actions.js'
import Debug from '@nichoth/debug'
const debug = Debug()

export type NodeState =
    | 'connected'
    | 'connecting'
    | 'disconnected'
    | 'sending'
    | 'synchronized'

/**
 * Logux has this in the CrossTabClient
 *
 * this.log.on('add', (action, meta) => {
      actionEvents(this.emitter, 'add', action, meta)
      if (meta.tab !== this.tabId) {
        sendToTabs(this, 'add', [this.tabId, action, meta])
      }
    })
 */

/**
 * CrossTabClient
 *   - Handle state related to leader/follower, if there are multiple
 *     tabs open.
 *   - Save state to indexedDB
 *   - Communicate with the server -- send and receive messages for state sync.
 *
 * @TODO
 * The client should keep a record of the `last_added` message and the
 * `last_synced` message, use them when sending the 'hello' message.
 */
export class CrossTabClient {
    role:'follower'|'leader' = 'follower'
    did:`did:key:z${string}`
    isLocalStorage:boolean = true
    initialized:boolean = false
    state:NodeState = 'disconnected'
    emitter:ReturnType<typeof createNanoEvents> = createNanoEvents()
    leaderState?:string
    /**
     * The serialized `seq`, and the ID (hash)
     */
    lastAddedCache:DeserializedSeq|-1 = -1
    lastSyncedCache:{ seq:DeserializedSeq, id:string }|-1 = -1
    lastReceived:number = 0
    lastSynced:{ seq: DeserializedSeq }|-1 = -1
    received:object = {}
    lastSent:number = 0
    syncing:number = 0
    initializing?:Promise<void>
    readonly userId:string
    readonly tabId:string = nanoid(8)
    readonly store:InstanceType<typeof IndexedStore>
    readonly party:InstanceType<typeof PartySocket>
    readonly prefix = 'partylog'
    unlead?:() => void

    constructor (opts:{
        host:string;
        did:`did:key:z${string}`;
        userId:string;
        token:string;
        sign?:(msg:string)=>Promise<string>
    }) {
        this.did = opts.did
        this.party = new PartySocket({
            party: 'main',
            host: opts.host,
            startClosed: true,
            query: { token: opts.token }
        })

        /**
         * __The Web Locks API__
         * > one or more scripts pass a promise to navigator.locks.request()
         * > to request a lock.
         *
         * > Once the lock is acquired, the promise is executed
         *
         * > when the promise resolves, the lock is released and can be acquired
         * > by another request.
         *
         * @see https://greenvitriol.com/posts/browser-leader
         */

        if (
            typeof navigator === 'undefined' ||
            !navigator.locks ||
            !this.isLocalStorage
        ) {
            // there is no navigator.locks API,
            // so make this the leader
            this.role = 'leader'
            this.party.reconnect()
        } else {
            // we can use navigator.locks to elect a leader tab
            navigator.locks.request('partylog_leader', () => {
                this.role = 'leader'
                this.party.reconnect()
                return new Promise<void>(resolve => {
                    this.unlead = resolve
                })
            })
        }

        this.party.onclose = () => {
            setState(this, 'disconnected')
        }

        this.party.onopen = async () => {
            setState(this, 'connected')
            /**
             * @TODO
             * should do a sync protocol in here
             */
            await this.initializing
            // this.sendHello()
            // const msg:ProtocolActions['hello'] = [
            //     'hello',
            //     { seq: this.lastAddedCache[1] },
            // ]
            // this.party.send(JSON.stringify(msg))
        }

        this.party.onmessage = (ev) => {
            /**
             * @TODO
             * handle incoming messages
             * initially, this will be 'sync' messages
             */
            debug('on message', JSON.parse(ev.data))
        }

        this.userId = opts.userId
        this.store = new IndexedStore({
            deviceName: 'alicesDevice',
            username: 'alice',
            did: 'did:key:z123',
            sign: opts.sign
        })

        /**
         * Listen for storage events
         * Used for inter-tab communication
         */
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('storage', ev => this.onStorage(ev))
        }

        this.initializing = this.initialize()
    }

    on (ev:'add', listener) {
        this.emitter.on(ev, listener)
    }

    /**
     * Factory function b/c async
     */
    static async create (opts:{
        host:string;
        did:`did:key:z${string}`;
        userId:string;
        token:string;
        sign?:(msg:string)=>Promise<string>
    }):Promise<InstanceType<typeof CrossTabClient>> {
        const client = new CrossTabClient(opts)
        await client.initialize()
        return client
    }

    async initialize ():Promise<void> {
        const [synced, added] = await Promise.all([
            this.store.getLastSynced(),
            this.store.getLastAdded()
        ])
        this.initialized = true
        this.lastSynced = synced
        this.lastAddedCache = added === -1 ? added : added.seq
    }

    /**
     * Send a message to the server
     */
    send (msg:any) {
        if (!this.party.OPEN) return

        try {
            this.party.send(JSON.stringify(msg))
        } catch (err) {
            console.error(err)
        }
    }

    /**
     * This does *not* notify other tabs of state change.
     */
    setState (state:NodeState) {
        if (this.state !== state) {
            this.state = state
        }
    }

    /**
     * @NOTE
     * The 'hello' message type.
     * Send a message ['hello', { seq, messages: ...data }]
     * Where data is everything that the server doesn't have
     */
    sendHello (entries:EncryptedMessage[]):void {
        debug('sending sync...', entries)

        /**
         * In here, should lookup the lastSynced and lastAdded numbers
         * and the `entries` -- list of messages
         */

        // ['hello', { seq: latest, messages: newMsgs }]

        const msg = HelloAction(this.lastAddedCache, entries)

        this.syncing++
        this.setState('sending')
        this.send(msg)
        if (this.syncing > 0) this.syncing--
        if (this.syncing === 0) {
            this.setState('synchronized')
        }
    }

    /**
     * Add a new action to the log, and send it to the server.
     *
     * @param {EncryptedMessage} msg The action
     * @param {{ sync?:boolean, scope:'post'|'private' }} opts Options
     * @returns {Promise<void>}
     */
    async add (
        msg:EncryptedMessage,
        opts:{ sync?:boolean, scope:'post'|'private' }
    ):Promise<Metadata|null> {
        const sync = opts.sync ?? true
        const meta = await this.store.add(msg, { scope: opts.scope })
        if (!meta) {
            // should not ever happen
            throw new Error('That ID already exists')
        }

        this.lastAddedCache = meta.seq
        this.emitter.emit('add', msg)
        sendToTabs(this, 'add', msg)

        if (sync) {
            this.send(JSON.stringify(msg))
            this.store.setLastSynced({ seq: meta.seq })
        }

        return meta
    }

    /**
     * Listen for storage events. This is relevant in multi-tab situations.
     *
     * @param {StorageEvent} ev Storage event
     * @returns {void}
     */
    onStorage (ev:StorageEvent) {
        if (ev.newValue === null) return
        let data

        /**
         * Listen for `add` events from other tabs
         */
        if (ev.key === storageKey(this, 'add')) {
            data = JSON.parse(ev.newValue)
            if (data[0] !== this.tabId) {
                const action = data[1]
                const meta = data[2]

                if (!meta.tab || meta.tab === this.tabId) {
                    // need to update our in-memory data with the new action

                    // if (isMemory(this.log.store)) {
                    //     this.log.store.add(action, meta)
                    // }

                    // this.node is a BaseNode

                    // actionEvents just emits events on the given emitter
                    // actionEvents(this.emitter, 'add', action, meta)

                    // this.node is a ClientNode from core,
                    // extends BaseNode
                    if (this.role === 'leader') {
                        // add to the local log
                        this.add(action)
                    }  // else, need to update the log store
                }
            } else if (ev.key === storageKey(this, 'state')) {
                const state = JSON.parse(localStorage.getItem(ev.key)!)
                if (this.leaderState !== state) {
                    this.leaderState = state
                }
            }
        }
    }

    /**
     * Close any resources used by this client
     */
    destroy () {
        this.role = 'follower'
        if (this.unlead) this.unlead()
        if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('storage', this.onStorage)
        }
    }

    get connected () {
        return this.state === 'connected'
    }

    clean () {
        if (this.isLocalStorage) {
            localStorage.removeItem(storageKey(this, 'add'))
            localStorage.removeItem(storageKey(this, 'state'))
            localStorage.removeItem(storageKey(this, 'client'))
        }
    }
}

function storageKey (
    client:InstanceType<typeof CrossTabClient>,
    name:string
) {
    return client.prefix + ':' + client.userId + ':' + name
}

/**
 * Tell the other tabs that something happened.
 *
 * @param client The client instance
 * @param event Either 'state', which means a change internal client state, eg,
 * connecting, synchronized, etc, or 'add', which means we just added a new
 * entry to the log.
 * @param data The event data
 * @returns {void}
 */
function sendToTabs (
    client:InstanceType<typeof CrossTabClient>,
    event:'state'|'add',
    data:any
):void {
    if (!client.isLocalStorage) return
    const key = storageKey(client, event)
    const json = JSON.stringify(data)

    try {
        localStorage.setItem(key, json)
    } catch (err) {
        console.error(err)
        client.isLocalStorage = false
        client.role = 'leader'
        client.party.reconnect()
    }
}

/**
 * Leader tab synchronization state. It can differs from `client.node.state`
 * (because only the leader tab keeps connection).
 *
 * ```js
 * client.on('state', () => {
 *   if (client.state === 'disconnected' && client.state === 'sending') {
 *     showCloseWarning()
 *   }
 * })
 * ```
 */
function setState (
    client:InstanceType<typeof CrossTabClient>,
    state:NodeState
) {
    if (client.state !== state) {
        client.state = state
        sendToTabs(client, 'state', client.state)
    }
}
