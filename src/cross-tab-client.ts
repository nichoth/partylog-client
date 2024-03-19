import { nanoid } from 'nanoid'
import { PartySocket } from 'partysocket'
import { createNanoEvents } from 'nanoevents'
import { createDeviceName } from '@bicycle-codes/identity'
import { IndexedStore } from './store.js'
import {
    Metadata,
    DeserializedSeq,
    EncryptedMessage,
    HelloAction,
    AnyProtocolAction,
    AddAction
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
    state:NodeState = 'disconnected'
    emitter:ReturnType<typeof createNanoEvents> = createNanoEvents()
    leaderState?:string
    /**
     * The serialized `seq`, and the ID (hash)
     */
    lastAddedCache:{ seq: DeserializedSeq|-1 } = { seq: -1 }
    lastSyncedCache:{ seq:DeserializedSeq|-1, id?:string } = { seq: -1 }
    lastReceived:number = 0
    received:object = {}
    lastSent:number = 0
    syncing:number = 0
    initializing?:Promise<void>
    initialized:boolean = false
    username:string
    readonly tabId:string = nanoid(8)
    readonly store:InstanceType<typeof IndexedStore>
    readonly party:InstanceType<typeof PartySocket>
    readonly prefix = 'partylog'
    unlead?:() => void

    constructor (opts:{
        host:string;
        did:`did:key:z${string}`;
        username:string;
        token:string;
        sign?:(msg:string)=>Promise<string>
    }) {
        this.did = opts.did
        this.username = opts.username

        /**
         * @see {@link https://docs.partykit.io/reference/partysocket-api/ party docs}
         * > that the id needs to be unique per connection, not per user
         *
         * But it's ok, because we are using the leader tab system,
         * so there is only 1 connection per device. You would want to
         * use the `deviceName`, though, not `username`.
         */
        this.party = new PartySocket({
            party: 'main',
            id: opts.username,
            room: 'main',
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

            this.sendHello()
        }

        this.party.onmessage = (ev) => {
            /**
             * @TODO
             * handle incoming messages
             */
            debug('got a message', JSON.parse(ev.data))
        }

        this.store = new IndexedStore({
            deviceName: opts.username,
            username: opts.username,
            did: this.did,
            sign: opts.sign
        })

        /**
         * For inter-tab communication
         */
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('storage', ev => this.onStorage(ev))
        }

        // this.initializing = this.initialize()
    }

    on (ev:'add', listener:(msg:EncryptedMessage)=>any) {
        this.emitter.on(ev, listener)
    }

    /**
     * Factory function b/c async
     */
    static async create (opts:{
        host:string;
        username?:string;
        did:`did:key:z${string}`;
        token:string;
        sign?:(msg:string)=>Promise<string>
    }):Promise<InstanceType<typeof CrossTabClient>> {
        const client = new CrossTabClient({
            ...opts,
            username: opts.username || await createDeviceName(opts.did)
        })
        await client.initialize()
        return client
    }

    async initialize ():Promise<void> {
        const [synced, added] = await Promise.all([
            this.store.getLastSynced(),
            this.store.getLastAdded()
        ])
        this.initialized = true
        this.lastSyncedCache = synced
        this.lastAddedCache = added.seq === -1 ? { seq: -1 } : added
    }

    /**
     * Send a message to the server
     * @TODO encrypt here or elsewhere?
     */
    send (msg:AnyProtocolAction) {
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
    async sendHello ():Promise<void> {
        const lastAdded = this.lastAddedCache.seq !== -1 ?
            this.lastAddedCache :
            await this.store.getLastAdded()

        const lastSynced = this.lastSyncedCache.seq !== -1 ?
            this.lastSyncedCache :
            await this.store.getLastSynced()

        // need to compare just the seq numbers for *this user*
        // this

        if (lastAdded.seq > lastSynced.seq) {
            /**
             * @TODO
             * get the difference between last synced and last added
             */
            debug('sending hello...', entries)
            const msg = HelloAction(this.lastAddedCache.seq, entries)
            this.send(msg)
            this.syncing++
            this.setState('sending')
            if (this.syncing > 0) this.syncing--
            if (this.syncing === 0) {
                /**
                 * @TODO
                 * What do we use these states for?
                 */
                this.setState('synchronized')
            }
        } else {
            // we have not added any new messages while we were offline
            const msg = HelloAction(this.lastAddedCache.seq)
            this.send(msg)
            // should get a response with any additional messages that the
            // server has
        }

        /**
         * This depends on what all data we save -- only ours, or our friend's
         * as well. In the latter case, would need to filter by username,
         * to get only *our* logs.
         */

        /**
         * In here, should lookup the lastSynced and lastAdded numbers
         * and the `entries` -- list of messages
         */

        // ['hello', { seq: latest, messages: newMsgs }]
    }

    /**
     * Add a new action to the log, and send it to the server.
     *
     * This will create valid metadata.
     *
     * @param {EncryptedMessage} msg The action
     * @param {{ sync?:boolean, scope:'post'|'private' }} opts Options
     * @returns {Promise<void>}
     *
     * @TODO -- encrypt here or elsewhere?
     */
    async add (
        msg:object,  // <-- the content for a message
        opts:{ sync?:boolean, scope:'post'|'private' }
    ):Promise<Metadata|null> {
        const sync = opts.sync ?? true
        const meta = await (await this.store).add(msg, { scope: opts.scope })
        if (!meta) {
            // should not ever happen
            throw new Error('That ID already exists')
        }

        const action = AddAction({
            metadata: meta,
            content: JSON.stringify(msg)
        })

        this.lastAddedCache = { seq: meta.seq }
        this.emitter.emit('add', msg)
        sendToTabs(this, 'add', msg)

        if (sync) {
            this.send(action);
            (await this.store).setLastSynced({ seq: meta.seq })
        }

        return meta
    }

    /**
     * Listen for storage events. This is relevant in multi-tab situations.
     *
     * @param {StorageEvent} ev Storage event
     * @returns {void}
     * @TODO -- implement this
     */
    onStorage (ev:StorageEvent) {
        if (ev.newValue === null) return
        let data

        // Add a message
        if (ev.key === storageKey(this, 'add')) {
            data = JSON.parse(ev.newValue)
            if (data[0] !== this.tabId) {
                const action = data[1]
                const meta = data[2]

                if (!meta.tab || meta.tab === this.tabId) {
                    // need to update our in-memory data with the new action

                    if (this.role === 'leader') {
                        // add to the local log
                        this.add(action, { scope: 'private' })
                    }  // else, need to update the log store
                }
            }
        // Change in leader state
        } else if (ev.key === storageKey(this, 'leader_state')) {
            const state = JSON.parse(localStorage.getItem(ev.key)!)
            if (this.leaderState !== state) {
                this.leaderState = state
            }
        // Connected state
        } else if (ev.key === storageKey(this, 'node_state')) {
            const state = JSON.parse(localStorage.getItem(ev.key)!)
            this.setState(state)
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
            localStorage.removeItem(storageKey(this, 'node_state'))
            localStorage.removeItem(storageKey(this, 'leader_state'))
        }
    }
}

export type AppStorageEvent =
    | 'add'
    | 'node_state'
    | 'leader_state'

function storageKey (
    client:InstanceType<typeof CrossTabClient>,
    name:AppStorageEvent
) {
    return client.prefix + ':' + client.username + ':' + name
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
    event:'leader_state'|'add'|'node_state',
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
 * Leader tab synchronization state.
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
        sendToTabs(client, 'node_state', client.state)
    }
}
