import { createDebug } from '@nichoth/debug'
// import { EntryStream } from 'level-web-stream'
import { toString } from 'uint8arrays'
import stringify from 'json-canon'
import { blake3 } from '@noble/hashes/blake3'
import ts from 'monotonic-timestamp'
import { BrowserLevel } from 'browser-level'
import { createDeviceName } from '@bicycle-codes/identity'
import charwise from 'charwise'
import {
    Action,
    Metadata,
    DeserializedSeq,
    DID,
    EncryptedMessage
} from './actions.js'
const debug = createDebug()

const VERSION = 1

debug('version', VERSION)

/**
 * [timestamp, localSeq, deviceName]
 */
// export type DeserializedSeq = [
//     timestamp:number,
//     localSeq:number,
//     deviceName:string
// ]

/**
 * __The Sync Algorithm__
 * Don't track offline/connected,
 * track lastSynced + the seq
 */

// export interface MetaData {
//     /**
//      * This is the primary key. It is:
//      *      `time + ':' + localSeq + ':' + this.deviceName`
//      *
//      * NOTE -- this is sorted correctly for multi-device updates, and
//      * guaranteed to by unique.
//      */
//     seq:string;

//     /**
//      * Hash of the previous message (need this for sync)
//      */
//     prev:string|null;

//     /**
//      * Unique ID (the hash of the metadata)
//      */
//     id:string;

//     /**
//      * Scope, used for querying
//      */
//     scope:string;

//     /**
//      * Public key used to sign this
//      */
//     author:`did:key:z${string}`;

//     /**
//      * Action created time in current node time. Milliseconds since UNIX epoch.
//      */
//     time:number;
// }

export interface SignedMetadata extends Metadata {
    signature:string
}

export interface LogPage<T> {
    /**
     * Pagination page.
     */
    entries:[Action<T>, Metadata][]

    /**
     * Next page loader.
     */
    next?():Promise<LogPage<T>>
}

export interface ReadonlyListener<
    ListenerAction extends Action,
    LogMeta extends Metadata
> {
    (action:ListenerAction, meta:LogMeta):void
}

export interface Entry<T=void> {
    action:Action<T>;
    meta:Metadata|SignedMetadata;
}

export class LevelStore {
    level:InstanceType<typeof BrowserLevel>
    readonly name:string = 'partylog'
    readonly deviceName:string

    constructor ({ deviceName }:{ deviceName:string }) {
        this.deviceName = deviceName
        this.level = new BrowserLevel('partylog', {
            keyEncoding: charwise
        })
    }
}

/**
 * A log store for IndexedDB.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology IndexedDB key characteristics}
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB Using IndexedDB}
 *
 * @property {DID} did This device's DID
 */
export class IndexedStore {
    readonly name:string
    readonly username:string
    readonly deviceName:string
    // a map from timestamp to boolean
    readonly adding:Record<string, boolean>
    readonly db:Promise<IDBDatabase>
    readonly level:InstanceType<typeof BrowserLevel>
    readonly did:DID
    readonly sign?:(meta:string)=>Promise<string>

    static async create (opts:{
        username:string,
        did:DID,
        sign?:(meta:string)=>Promise<string>
    }) {
        const deviceName = await createDeviceName(opts.did)
        const store = new IndexedStore({ ...opts, deviceName })
        return store
    }

    constructor (opts:{
        username:string,
        deviceName:string,
        did:DID,
        sign?:(meta:string)=>Promise<string>
    }, name = 'partylog') {
        this.name = name
        this.deviceName = opts.deviceName
        this.username = opts.username
        this.adding = {}
        this.sign = opts.sign

        /**
         * `did` is added to metadata as the `author` field.
         */
        this.did = opts.did

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
                        keyPath: 'seq'
                    })

                    // the hash of the metadata
                    log.createIndex('id', 'meta.id', { unique: true })
                    log.createIndex('localSeq', 'meta.localSeq', { unique: true })
                    log.createIndex('seq', 'meta.seq', { unique: true })
                    log.createIndex('type', 'type', { unique: false })
                    // if the server gets 2 actions created at the same time
                    // by different devices
                    log.createIndex('time', 'meta.time', { unique: false })
                    db.createObjectStore('extra', { keyPath: 'key' })
                }
            }

            /**
             * __Get data from the DB__
             * db.transaction('log')
             *   .objectStore(storeName)
             *   .index('seq')
             *   .get(mySeqValue)
             */
        })
    }

    /**
     * @TODO
     * Do we want to do this?
     */
    // async getRecordsSinceOffline () {
    //     const os = await this.os('log')
    //     const index = os.index('type')
    //     const cursor = await promisify<IDBCursorWithValue|null>(
    //         index.openCursor('offline', 'prev')
    //     )
    //     cursor?.value
    // }

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
     * @returns {Promise<null|Metadata>} Return `null` if the add operation
     * failed, eg b/c the given ID already exists, or we are already adding it.
     * Return `Metadata` otherwise.
     */
    async add<T=void> (
        // action:Action<T>,
        msg:EncryptedMessage,
        prev?:Action<T>
    ):Promise<Metadata|null> {
        const lastAdded = await this.getLastAdded()
        let localSeq:number
        if (lastAdded === -1) localSeq = 0
        else localSeq = lastAdded[1]

        const timestamp:number = ts()

        // a seq that sorts correctly
        // time + local seq integer + deviceName
        // const seq = '' + time + ':' + localSeq + ':' + this.deviceName
        const seq = [timestamp, localSeq, this.deviceName] as const

        // proof, username, scope

        let newMetadata:Omit<Omit<SignedMetadata, 'id'>, 'signature'> = {
            prev: prev ? prev.metadata!.id : null,
            seq,
            timestamp,
            author: this.did
        }

        if (this.sign) {
            // sign the metadata, then create the ID
            (newMetadata as Omit<SignedMetadata, 'id'>) = Object.assign(
                newMetadata,
                { signature: await this.sign(stringify(newMetadata)) }
            );

            (newMetadata as SignedMetadata) = Object.assign(
                newMetadata as Omit<SignedMetadata, 'id'>,
                { id: toString(blake3(stringify(newMetadata)), 'base64urlpad') }
            )
        } else {
            // no signature, just create an ID
            (newMetadata as Metadata) = Object.assign(newMetadata, {
                id: toString(blake3(stringify(newMetadata)), 'base64urlpad')
            })
        }

        /**
         * @TODO
         * Need to send the new entry to the websocket server, after
         * adding it to our local DB.
         *   - should delete the `localSeq` from the metadata and entry,
         *     probably server-side
         */

        const entry:Entry<T> = {
            action,
            seq,
            localSeq,
            id: (newMetadata as Metadata).id,
            time,
            meta: newMetadata as Metadata
        }

        if (this.adding[entry.localSeq]) {
            return null
        }
        this.adding[entry.localSeq] = true

        // this will not happen
        const exist = await promisify(
            (await this.os('log')).index('id').get(entry.id)
        )

        if (exist) return null

        await (await this.os('log', 'write')).add(entry)
        delete this.adding[entry.localSeq]
        // here -- should send to server
        // this should happen in the client
        return newMetadata as Metadata
    }

    /**
     * Get an action by ID
     *
     * @param {string} id The ID
     * @returns {Promise<[Action<T>, Metadata]|[null, null]>}
     */
    async byId<T> (id:string):Promise<[Action<T>, Metadata]|[null, null]> {
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
     * @param {Partial<Metadata>} diff The updates
     * @returns {Promise<boolean>} True if update was successful, false if the
     * given ID was not found.
     */
    async changeMeta (id:string, diff:Partial<Metadata>):Promise<boolean> {
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
     * `entries` with part of the results, and a `next` property with a
     * function to load the next page. If this was the last page, `next`
     * property should be empty.
     *
     * We need a pagination API because the log could be very big.
     *
     * @param {{ index, order }} opts Query options.
     * @returns Promise with first page.
     */
    async get<T=void> ({ index, order }:{
        index:string;
        order?:'time'
    }):Promise<LogPage<T>> {
        return new Promise((resolve, reject) => {
            this.os('log').then(log => {
                let request:IDBRequest<IDBCursorWithValue|null>
                if (index) {
                    if (order === 'time') {
                        // index and order === time
                        request = log.index('time').openCursor(null, 'prev')
                    } else {
                        // index, order !== time
                        const keyRange = IDBKeyRange.only(index)
                        request = log.index('indexes').openCursor(keyRange, 'prev')
                    }
                } else if (order === 'time') {
                    // not index, but order === time
                    request = log.index('time').openCursor(null, 'prev')
                } else {
                    // not index, and order !== time
                    request = log.openCursor(null, 'prev')
                }

                request.onerror = (err) => { reject(err) }

                const entries:[Action<T>, Metadata][] = []
                request.onsuccess = () => {
                    const cursor = request.result
                    if (!cursor) return resolve({ entries })
                    if (!index || cursor.value.indexes.includes(index)) {
                        cursor.value.meta.seq = cursor.value.seq
                        entries.unshift([cursor.value.action, cursor.value.meta])
                    }
                    cursor.continue()
                }
            })
        })
    }

    /**
     * Get the last added `seq` number of actions.
     * @TODO -- cache this value
     * @returns {Promise<DeserializedSeq>}
     */
    async getLastAdded ():Promise<{ seq:string, id:string }|-1> {
        const cursor = await promisify<IDBCursorWithValue|null>(
            (await this.os('log')).openCursor(null, 'prev')
        )

        return (cursor ?
            { seq: cursor.value.seq, id: cursor.value.id } :
            -1)
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
     *
     * Remove an action from the local store.
     *
     * @param {string} id The ID to delete
     * @returns {Promise<null|[Action, Metadata]>} `null` if the ID does not
     * exist, the removed action otherwise.
     */
    async remove (id:string):Promise<null|[Action, Metadata]> {
        const entry = await promisify<Entry>(
            (await this.os('log')).index('id').get(id)
        )
        if (!entry) return null;

        (await this.os('log', 'write')).delete(entry.seq)
        entry.meta.seq = entry.seq
        return [entry.action, entry.meta]
    }

    /**
     * Set the last synced values. Should pass this the `seq` string from
     * actions.
     *
     * @param values The `seq` string sent or received
     */
    async setLastSynced (
        values:Partial<{ sent:string, received:string }>
    ):Promise<void> {
        let data:{
            key:'lastSynced',
            received:string|-1,
            sent:string|-1
        } = await promisify((await this.os('extra')).get('lastSynced'))

        if (!data) data = { key: 'lastSynced', received: -1, sent: -1 }
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
 * @param {Partial<Metadata>} firstMeta Some action’s metadata.
 * @param {Partial<Metadata>} secondMeta Other action’s metadata.
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

/**
 * Take a `seq` as a string, return an array of its contents.
 * @param {string} seq The `seq` string to parse
 * @returns {DeserializedSeq} An array of `seq` contents
 */
export function deserializeSeq (
    seq:string|-1
):DeserializedSeq|-1 {
    if (seq === -1) return -1
    const parts = seq.split(':')
    return [parseInt(parts[0]), parseInt(parts[1]), parts[2]]
}

/**
 * Take a deserialized `seq`, return the string version.
 * @param seq Deserialized `seq`
 * @returns {string}
 */
export function serializeSeq (seq:DeserializedSeq):string {
    return '' + seq[0] + ':' + seq[1] + ':' + seq[2]
}
