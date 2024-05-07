import { nanoid } from 'nanoid'
import { PartySocket } from 'partysocket'
import { createNanoEvents } from 'nanoevents'
import { createDeviceName } from '@bicycle-codes/identity'
import { IndexedStore } from './store.js'
import {
    Metadata,
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
 */
export class CrossTabClient {
    role:'follower'|'leader' = 'follower'
    did:`did:key:z${string}`
    state:NodeState = 'disconnected'
    isLocalStorage:boolean = true
    private emitter:ReturnType<typeof createNanoEvents> = createNanoEvents()
    private leaderState?:string
    /**
     * The serialized `seq`, and the ID (hash)
     */
    private lastAddedCache:{ localSeq:number } = { localSeq: -1 }
    private lastSyncedCache:{
        localSeq:number,
    } = { localSeq: -1 }

    initialized:boolean = false
    username:string
    readonly tabId:string = nanoid(8)
    private store?:InstanceType<typeof IndexedStore>
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
            // note that the id needs to be unique per connection,
            // not per user, so e.g. multiple devices or tabs need a different id
            // id: opts.username,  // @FIXME <-- should be deviceName, not username
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
            this.setState('disconnected')
        }

        this.party.onopen = async () => {
            this.setState('connected')
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

        // this.store = new IndexedStore({
        //     deviceName: opts.username,
        //     username: opts.username,
        //     did: this.did,
        //     sign: opts.sign
        // })

        /**
         * For inter-tab communication
         */
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('storage', ev => this.onStorage(ev))
        }
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
        token:string;
        did:`did:key:z${string}`;
        sign?:(msg:string)=>Promise<string>
    }):Promise<InstanceType<typeof CrossTabClient>> {
        const username = opts.username || await createDeviceName(opts.did)
        const client = new CrossTabClient({
            ...opts,
            username
        })
        client.store = await IndexedStore.create({ ...opts, username })
        await client.initialize()
        return client
    }

    async initialize ():Promise<void> {
        const [synced, added] = await Promise.all([
            this.store!.getLastSynced(),
            this.store!.getLastAdded()
        ])
        this.lastSyncedCache = synced
        this.lastAddedCache = added.localSeq === -1 ? { localSeq: -1 } : added
        this.initialized = true
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
        const lastAdded = this.lastAddedCache.localSeq !== -1 ?
            this.lastAddedCache :
            await this.store!.getLastAdded()

        const lastSynced = this.lastSyncedCache.localSeq !== -1 ?
            this.lastSyncedCache :
            await this.store!.getLastSynced()

        // need to compare the seq numbers for *this user*

        if (lastAdded.localSeq > lastSynced.localSeq) {
            /**
             * @TODO
             * get the difference between last synced and last added
             */
            debug('sending hello...', 'entries')
            // @TODO
            const msg = HelloAction(this.lastAddedCache.localSeq, [])
            this.send(msg)
        } else {
            // we have not added any new messages while we were offline
            const msg = HelloAction(this.lastAddedCache.localSeq)
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
        const meta = await (await this.store!).add(msg, { scope: opts.scope })
        if (!meta) {
            // should not ever happen
            throw new Error('That ID already exists')
        }

        const action = AddAction({
            metadata: meta,
            content: JSON.stringify(msg)
        })

        this.lastAddedCache = { localSeq: meta.localSeq }
        this.emitter.emit('add', msg)
        this.sendToTabs('add', msg)

        if (sync) {
            this.send(action);
            (await this.store!).setLastSynced({ localSeq: meta.localSeq })
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

    sendToTabs (
        event:'leader_state'|'add'|'node_state',
        data:any
    ):void {
        if (!this.isLocalStorage) return
        const key = storageKey(this, event)
        const json = JSON.stringify(data)

        try {
            localStorage.setItem(key, json)
        } catch (err) {
            console.error(err)
            this.isLocalStorage = false
            this.role = 'leader'
            this.party.reconnect()
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

// /**
//  * Tell the other tabs that something happened.
//  *
//  * @param client The client instance
//  * @param event Either 'state', which means a change internal client state, eg,
//  * connecting, synchronized, etc, or 'add', which means we just added a new
//  * entry to the log.
//  * @param data The event data
//  * @returns {void}
//  */
// function sendToTabs (
//     client:InstanceType<typeof CrossTabClient>,
//     event:'leader_state'|'add'|'node_state',
//     data:any
// ):void {
//     if (!client.isLocalStorage) return
//     const key = storageKey(client, event)
//     const json = JSON.stringify(data)

//     try {
//         localStorage.setItem(key, json)
//     } catch (err) {
//         console.error(err)
//         client.isLocalStorage = false
//         client.role = 'leader'
//         client.party.reconnect()
//     }
// }

// /**
//  * Leader tab synchronization state.
//  *
//  * ```js
//  * client.on('state', () => {
//  *   if (client.state === 'disconnected' && client.state === 'sending') {
//  *     showCloseWarning()
//  *   }
//  * })
//  * ```
//  */
// function setState (
//     client:InstanceType<typeof CrossTabClient>,
//     state:NodeState
// ) {
//     if (client.state !== state) {
//         client.state = state
//         sendToTabs(client, 'node_state', client.state)
//     }
// }
