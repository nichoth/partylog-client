import { createDebug } from '@nichoth/debug'
import { toString } from 'uint8arrays'
import stringify from 'json-canon'
import { blake3 } from '@noble/hashes/blake3'
import ts from 'monotonic-timestamp'
import { BrowserLevel } from 'browser-level'
import { Action } from './actions.js'
const debug = createDebug()

const VERSION = 1

debug('version', VERSION)

export interface MetaData {
    /**
     * This is the primary key. It is:
     *      time + deviceName + local seq integer
     *
     * Note this is sorted correctly for multi-device updates, and
     * guaranteed to by unique.
     */
    seq:string;

    /**
     * The sequence number
     */
    localSeq:number;

    /**
     * Hash of the previous message (need this for sync)
     */
    prev:string;

    /**
     * Action unique ID. Log sets it automatically.
     */
    id:string;

    /**
     * Public key used to sign this
     */
    author:`did:key:z${string}`;

    /**
     * signature, base64 encoded
     */
    signature:string;

    /**
     * Action created time in current node time. Milliseconds since UNIX epoch.
     */
    time:number;
}

export interface LogPage<T> {
    /**
     * Pagination page.
     */
    entries:[Action<T>, MetaData][]

    /**
     * Next page loader.
     */
    next?():Promise<LogPage<T>>
}

export interface ReadonlyListener<
    ListenerAction extends Action,
    LogMeta extends MetaData
> {
    (action:ListenerAction, meta:LogMeta):void
}

export interface Criteria {
    /**
     * Remove reason only for action with `id`.
     */
    id?:string

    /**
     * Remove reason only for actions with lower `added`.
     */
    maxAdded?:number

    /**
     * Remove reason only for actions with bigger `added`.
     */
    minAdded?:number

    /**
     * Remove reason only older than specific action.
     */
    olderThan?:MetaData

    /**
     * Remove reason only younger than specific action.
     */
    youngerThan?:MetaData
}

/**
 * IndexedDB indexed can only be 1 level deep;
 * that's why we have duplicate keys on the top level & metadata
 */
export interface Entry<T=void> {
    seq:string;
    action:Action<T>;
    id:string;
    meta:MetaData;
    time:number;
}

/**
 * A log store for IndexedDB.
 * @see https://logux.org/web-api/#indexedstore
 */
export class IndexedStore {
    readonly name:string
    readonly deviceName:string
    // a map from timestamp to boolean
    readonly adding:Record<string, boolean>
    readonly db:Promise<IDBDatabase>
    readonly level:InstanceType<typeof BrowserLevel>

    constructor (opts:{ deviceName:string }, name = 'partylog') {
        this.name = name
        this.deviceName = opts.deviceName
        this.adding = {}

        // HERE -- what is the name passed to BrowserLevel?
        // is this like the `name` passed to the objectStore method of IDB?
        this.level = new BrowserLevel('log')

        this.db = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.name, VERSION)
            req.onerror = err => reject(err)

            req.onsuccess = () => resolve(req.result)

            /**
             * This handler fires when a new database is created and indicates
             * either that one has not been created before, or a new version
             * was submitted with window.indexedDB.open()
             * @see https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/createIndex#examples
             */
            req.onupgradeneeded = function (ev) {
                const db = req.result

                let log:IDBObjectStore
                if (ev.oldVersion < 1) {
                    log = db.createObjectStore('log', {
                        // autoIncrement: true,
                        autoIncrement: false,
                        keyPath: 'id'
                    })

                    // the hash of the metadata
                    log.createIndex('id', 'id', { unique: true })
                    log.createIndex('localSeq', 'localSeq', { unique: true })
                    log.createIndex('seq', 'seq', { unique: true })
                    // if the server gets 2 actions created at the same time
                    // by different devices
                    log.createIndex('time', 'time', { unique: false })
                    db.createObjectStore('extra', { keyPath: 'key' })
                }
            }
        })
    }

    /**
     * Get a new objectstore.
     *
     * @param {'log'|'extra'} name Object store name, 'log' | 'extra'
     * @param {'write'} [write] Writable or read only?
     * @returns {Promise<IDBObjectStore>}
     */
    async os (name:'log'|'extra', write?:'write'):Promise<IDBObjectStore> {
        const mode = write ? 'readwrite' : 'readonly'
        return (await this.db).transaction(name, mode).objectStore(name)
    }

    /**
     * Add an action to `IndexedDB`. Valid `MetaData` will be created.
     *
     * ID is the hash of the metadata.
     *
     * @param {Action} action
     * @param {MetaData} meta
     * @returns {Promise<null|MetaData>} Return `null` if the add operation
     * failed, eg b/c the given ID already exists, or we are already adding it.
     * Return `MetaData` otherwise.
     */
    async add<T=void> (
        action:Action<T>,
        prev?:Action<T>
    ):Promise<MetaData|null> {
        // Can we cache the `lastAdded` value?
        const localSeq:number = (await this.getLastAdded() + 1)
        const created:number = ts()

        // a seq that sorts correctly
        // time + deviceName + local seq integer
        const seq = '' + created + ':' + this.deviceName + ':' + localSeq

        const newMetadata:Omit<MetaData, 'id'> = {
            prev: prev ? prev.meta!.id : '',
            seq,
            localSeq,
            time: created,
            author: 'did:key:z123',
            signature: '123'
        }

        // take the hash of the metadata
        const newID = toString(blake3(stringify(newMetadata)), 'base64urlpad')

        const entry:Entry<T> = {
            action,
            seq,
            id: newID,
            time: created,
            meta: { id: newID, ...newMetadata },
        }

        if (this.adding[entry.seq]) {
            return null
        }
        this.adding[entry.seq] = true

        const exist = await promisify(
            (await this.os('log')).index('id').get(entry.id)
        )

        if (exist) return null

        await (await this.os('log', 'write')).add(entry)
        delete this.adding[entry.seq]
        return newMetadata as MetaData
    }

    /**
     * Get an action by ID
     *
     * @param {string} id The ID
     * @returns {Promise<[Action<T>, MetaData]|[null, null]>}
     */
    async byId<T> (id:string):Promise<[Action<T>, MetaData]|[null, null]> {
        const result = await promisify<{
            action,
            meta
        }>((await this.os('log')).index('id').get(id))

        if (result) return [result.action, result.meta]
        return [null, null]
    }

    /**
     * Update the metadata of the given ID.
     *
     * @param {string} id The ID to update
     * @param {Partial<MetaData>} diff The updates
     * @returns {Promise<boolean>} True if update was successful, false if the
     * given ID was not found.
     */
    async changeMeta (id:string, diff:Partial<MetaData>):Promise<boolean> {
        const entry = await promisify<Entry>(
            (await this.os('log')).index('id').get(id)
        )
        if (!entry) return false

        for (const key in diff) entry.meta[key] = diff[key];
        (await this.os('log', 'write')).put(entry)
        return true
    }

    /**
     * Delete this database.
     * @returns {Promise<void>}
     */
    async clean () {
        (await this.db).close()
        indexedDB.deleteDatabase(this.name)
    }

    /**
     * Return a Promise with the first page. The Page object has a property
     * `entries` property with part of results and `next` property with a
     * function to load the * next page. If it was the last page, `next`
     * property should be empty.
     *
     * We need a pagination API because the log could be very big.
     *
     * @param {{ index, order }} opts Query options.
     * @returns Promise with first page.
     */
    async get<T=void> ({ index, order }:{
        index:string;
        order?:'created'
    }):Promise<LogPage<T>> {
        return new Promise((resolve, reject) => {
            this.os('log').then(log => {
                let request
                if (index) {
                    if (order === 'created') {
                        request = log.index('created')
                    } else {
                        const keyRange = IDBKeyRange.only(index)
                        request = log.index('indexes').openCursor(keyRange, 'prev')
                    }
                } else if (order === 'created') {
                    request = log.index('created').openCursor(null, 'prev')
                } else {
                    request = log.openCursor(null, 'prev')
                }

                request.onerror = (err) => { reject(err) }

                const entries:[Action<T>, MetaData][] = []
                request.onsuccess = (ev) => {
                    const cursor = ev.target.result
                    if (!cursor) return resolve({ entries })
                    if (!index || cursor.value.indexes.includes(index)) {
                        cursor.value.meta.added = cursor.value.added
                        entries.unshift([cursor.value.action, cursor.value.meta])
                    }
                    cursor.continue()
                }
            })
        })
    }

    /**
     * Get the last added `seq` number of actions.
     * @returns {Promise<number>}
     */
    async getLastAdded ():Promise<number> {
        const cursor = await promisify<IDBCursorWithValue|null>(
            (await this.os('log')).openCursor(null, 'prev')
        )

        return cursor ? parseInt(cursor.value.seq) : 0
    }

    /**
     * Get { received, sent } numbers for last synced
     * @returns {Promise<{ received:number, sent:number }>}
     */
    async getLastSynced ():Promise<{ received:number, sent:number }> {
        const data:{
            received:number,
            sent:number
        } = await promisify<{ received, sent }>(
            (await this.os('extra')).get('lastSynced')
        )

        if (data) {
            return { received: data.received, sent: data.sent }
        } else {
            return { received: 0, sent: 0 }
        }
    }

    /**
     * @TODO -- delete the content, keep the metadata
     * @TODO -- sync delete actions with the remote store
     * Remove an action from the local store.
     * @param {string} id The ID to delete
     * @returns {Promise<null|[Action, MetaData]>} `null` if the ID does not
     * exist, the removed action otherwise.
     */
    async remove (id:string):Promise<null|[Action, MetaData]> {
        const entry = await promisify<Entry>(
            (await this.os('log')).index('id').get(id)
        )
        if (!entry) return null;

        (await this.os('log', 'write')).delete(entry.seq)
        entry.meta.seq = entry.seq
        return [entry.action, entry.meta]
    }

    /**
     * Set the last synced values.
     *
     * @param values Sent & received numbers.
     */
    async setLastSynced (
        values:Partial<{ sent:number, received:number }>
    ):Promise<void> {
        let data:{
            key:'lastSynced',
            received:number,
            sent:number
        } = await promisify((await this.os('extra')).get('lastSynced'))

        if (!data) data = { key: 'lastSynced', received: 0, sent: 0 }
        if (typeof values.sent !== 'undefined') {
            data.sent = values.sent
        }
        if (typeof values.received !== 'undefined') {
            data.received = values.received
        }

        (await this.os('extra', 'write')).put(data)
    }
}

/**
 * Compare the time when two log entries were created.
 *
 * It uses `meta.time` and `meta.id` to detect entries order.
 *
 * @example
 * ```js
 * import { isFirstOlder } from '@bicycle-codes/partylog-client'
 * if (isFirstOlder(lastBeep, nextBeep)) {
 *   beep(action)
 *   lastBeep = meta
 * }
 * ```
 *
 * @param {Partial<MetaData>} firstMeta Some action’s metadata.
 * @param {Partial<MetaData>} secondMeta Other action’s metadata.
 */
export function isFirstOlder (
    firstMeta:{ time:number },
    secondMeta:{ time:number }
):boolean {
    return (firstMeta.time < secondMeta.time)
}

/**
 * Take an IDB request, turn it into a promise.
 *
 * @param request IDB request
 * @returns {Promise<IDBRequest['result']>}
 */
function promisify<T> (request:IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        rejectify(request, reject)
        request.onsuccess = () => {
            resolve(request.result)
        }
    })
}

/**
 * Take an indexed DB request, and reject the promise on error.
 *
 * @param request Indexed DB request
 * @param reject Reject function to call with error
 */
function rejectify (request:IDBRequest, reject:(err?)=>void) {
    request.onerror = () => {
        reject(request.error)
    }
}
