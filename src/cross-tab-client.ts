// import { actionEvents, LoguxError } from '@logux/core'
import { nanoid } from 'nanoid'
import { PartySocket } from 'partysocket'

import { IndexedStore, MetaData } from './store.js'
import { Action } from './actions.js'
import Debug from '@nichoth/debug'
export * as Actions from './actions.js'
const debug = Debug()

// function compareSubprotocols (left, right) {
//     const leftParts = left.split('.')
//     const rightParts = right.split('.')
//     for (let i = 0; i < 3; i++) {
//         const leftNumber = parseInt(leftParts[i] || 0)
//         const rightNumber = parseInt(rightParts[i] || 0)
//         if (leftNumber > rightNumber) {
//             return 1
//         } else if (leftNumber < rightNumber) {
//             return -1
//         }
//     }
//     return 0
// }

export type NodeState =
    | 'connected'
    | 'connecting'
    | 'disconnected'
    | 'sending'
    | 'synchronized'

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
    isLocalStorage:boolean = true
    initialized:boolean = false
    state:NodeState = 'disconnected'
    leaderState?:string
    lastAddedCache:number = 0  // latest `seq` number
    lastReceived:number = 0
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
        userId:string;
        token:string;
    }) {
        this.party = new PartySocket({
            host: opts.host,
            // start websocket in CLOSED state; call `.reconnect()` to connect
            startClosed: true,
            query: { token: opts.token }
        })

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

        this.party.onopen = () => {
            setState(this, 'connected')
        }

        this.userId = opts.userId
        this.store = new IndexedStore()

        /**
         * Listen for storage events
         * Used for inter-tab communication
         */
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('storage', ev => this.onStorage(ev))
        }

        this.initializing = this.initialize()
    }

    async initialize ():Promise<void> {
        const [synced, added] = await Promise.all([
            this.store.getLastSynced(),
            this.store.getLastAdded()
        ])
        this.initialized = true
        this.lastSent = synced.sent
        this.lastReceived = synced.received
        this.lastAddedCache = added
    }

    /**
     * Send a message to the server
     */
    send (msg:any) {
        if (!this.connected) return

        try {
            this.party.send(JSON.stringify(msg))
        } catch (err) {
            console.error(err)
        }
    }

    async syncEvent (
        action:Action,
        meta:MetaData
    ) {
        let seq = meta.seq
        if (typeof seq === 'undefined') {
            const lastAdded = this.lastAddedCache
            seq = (lastAdded > this.lastSent) ? lastAdded : this.lastSent
        }

        this.sendSync(seq, [[action, meta]])
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
     * The 'sync' message type
     */
    sendSync (seq:number, entries:[Action, MetaData][]) {
        debug('sending sync...', entries)

        const data:(Action|MetaData)[] = []
        for (const [action, originMeta] of entries) {
            const meta:Partial<MetaData> = {}
            for (const key in originMeta) {
                if (key !== 'seq') {
                    meta[key] = originMeta[key]
                }
            }

            data.unshift(action, meta as MetaData)
        }

        this.syncing++
        this.setState('sending')
        this.send(['sync', seq, ...data])
        if (this.syncing > 0) this.syncing--
        if (this.syncing === 0) {
            this.setState('synchronized')
        }
    }

    /**
     * Add a new action to the log.
     *
     * @param {Action} action The action
     * @param {MetaData} meta Metadata
     * @returns {Promise<void>}
     */
    async add (action:Action):Promise<MetaData|null> {
        const meta = await this.store.add(action)
        if (!meta) {
            // should not ever happen
            throw new Error('That ID already exists')
        }

        if (this.lastAddedCache < meta.seq) {
            this.lastAddedCache = meta.seq
        }

        if (this.received && this.received[meta.id]) {
            delete this.received[meta.id]
            return null
        }

        const addedMeta = await this.store.add(action, meta)

        this.syncEvent(action, meta)

        return addedMeta
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
         * `add` event
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
                        this.add(action, meta)
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

    getClientId () {
        return nanoid(8)
    }
}

// on storage event in client

/*
window.addEventListener('storage', e => this.onStorage(e))
*/

/*
 onStorage(e) {
    if (e.newValue === null) return

    let data
    if (e.key === storageKey(this, 'add')) {
      data = JSON.parse(e.newValue)
      if (data[0] !== this.tabId) {
        let action = data[1]
        let meta = data[2]
        if (!meta.tab || meta.tab === this.tabId) {
          if (isMemory(this.log.store)) {
            this.log.store.add(action, meta)
          }
          actionEvents(this.emitter, 'add', action, meta)
          if (this.role === 'leader') {
            this.node.onAdd(action, meta)
          }
        }
      }
    } else if (e.key === storageKey(this, 'state')) {
      let state = JSON.parse(localStorage.getItem(e.key))
      if (this.leaderState !== state) {
        this.leaderState = state
        this.emitter.emit('state')
      }
    } else if (e.key === storageKey(this, 'user')) {
      data = JSON.parse(e.newValue)
      if (data[0] !== this.tabId) {
        this.emitter.emit('user', data[1])
      }
    } else if (e.key === storageKey(this, 'subprotocol')) {
      let other = JSON.parse(e.newValue)
      let compare = compareSubprotocols(this.options.subprotocol, other)
      if (compare === 1) {
        sendToTabs(this, 'subprotocol', this.options.subprotocol)
      } else if (compare === -1) {
        let err = new LoguxError(
          'wrong-subprotocol',
          { supported: other, used: this.options.subprotocol },
          true
        )
        this.node.emitter.emit('error', err)
      }
    }
  }
*/

/**
 * __The Web Locks API__
 * > one or more scripts pass a promise to navigator.locks.request() to request
 * > a lock.
 *
 * > Once the lock is acquired, the promise is executed
 *
 * > when the promise resolves, the lock is released and can be acquired by
 * > another request.
 */

function storageKey (
    client:InstanceType<typeof CrossTabClient>,
    name:string
) {
    return client.prefix + ':' + client.userId + ':' + name
}

function sendToTabs (
    client:InstanceType<typeof CrossTabClient>,
    event:string,
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
