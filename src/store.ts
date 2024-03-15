import { createDebug } from '@nichoth/debug'
import { toString } from 'uint8arrays'
import stringify from 'json-canon'
import { blake3 } from '@noble/hashes/blake3'
import ts from 'monotonic-timestamp'
import { Action } from './actions.js'
const debug = createDebug()

const VERSION = 1

debug('version', VERSION)

export type ID = string

export interface MetaData {
    /**
     * Sequence number of action in current log. Log fills it.
     */
    seq:number

    /**
     * Action unique ID. Log sets it automatically.
     */
    id:ID

    /**
     * Why action should be kept in the log.
     * Actions without reasons will be removed.
     */
    reasons:string[]

    /**
     * Set code as reason and remove this reasons from previous actions.
     */
    subprotocol?:string

    /**
     * Action created time in current node time. Milliseconds since UNIX epoch.
     */
    time:number
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
    id?:ID

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

export interface Entry<T=void> {
    seq:number;
    action:Action<T>;
    created:string;
    id:string;
    meta:MetaData;
    reasons:string[];
    time:number;
}

/**
 * A log store that uses IndexedDB.
 * @see https://logux.org/web-api/#indexedstore
 */
export class IndexedStore {
    readonly name:string
    // a map from timestamp to boolean
    readonly adding:Record<string, boolean>
    readonly db:Promise<IDBDatabase>

    constructor (name = 'partylog') {
        this.name = name
        this.adding = {}

        this.db = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.name, VERSION)
            req.onerror = err => reject(err)

            req.onsuccess = () => resolve(req.result)

            req.onupgradeneeded = function (ev) {
                const db = req.result

                let log:IDBObjectStore
                if (ev.oldVersion < 1) {
                    log = db.createObjectStore('log', {
                        autoIncrement: true,
                        keyPath: 'seq'
                    })
                    log.createIndex('id', 'id', { unique: true })
                    log.createIndex('created', 'created', { unique: true })
                    log.createIndex('reasons', 'reasons', { multiEntry: true })
                    db.createObjectStore('extra', { keyPath: 'key' })
                }
                if (ev.oldVersion < 2) {
                    if (!log!) {
                        log = req.transaction!.objectStore('log')
                    }
                    log.createIndex('indexes', 'indexes', { multiEntry: true })
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
     * failed, eg b/c the given ID already exists. Return `MetaData` otherwise.
     */
    async add<T=void> (
        action:Action<T>,
        meta:{ reasons?:string[]; subprotocol?:string } = {}
    ):Promise<MetaData|null> {
        const seq = (await this.getLastAdded() + 1)
        const created:number = ts()

        // take the hash of the metadata
        const newID = toString(blake3(stringify({
            seq,
            reasons: meta.reasons || [],
            subprotocol: meta.subprotocol,
            time: created
        })), 'base64urlpad')

        const newMetadata:MetaData = {
            id: newID,
            seq,
            reasons: meta.reasons || [],
            subprotocol: meta.subprotocol,
            time: created
        }

        const entry:Entry<T> = {
            action,
            created: '' + created,
            meta: newMetadata,
            seq,
            reasons: newMetadata.reasons,
            time: created,
            id: newID,
        }

        if (this.adding[entry.created]) {
            return null
        }
        this.adding[entry.created] = true

        const exist = await promisify(
            (await this.os('log')).index('id').get(newMetadata.id)
        )

        if (exist) return null

        await (await this.os('log', 'write')).add(entry)
        delete this.adding[entry.created]
        return newMetadata
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

        for (const key in diff) entry.meta[key] = diff[key]
        if (diff.reasons) entry.reasons = diff.reasons;
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
     * Remove the given reason, and remove the action if its reasons is empty.
     * @param reason The reason to remove.
     * @param criteria Criteria to use to query
     * @param cb Callback when done.
     */
    async removeReason (
        reason:string,
        criteria:Criteria,
        cb:ReadonlyListener<Action, MetaData>
    ):Promise<void> {
        if (criteria.id) {
            const entry = await promisify<Entry>(
                (await this.os('log')).index('id').get(criteria.id)
            )

            if (entry) {
                const index = entry.meta.reasons.indexOf(reason)
                if (index !== -1) {
                    entry.meta.reasons.splice(index, 1)
                    entry.reasons = entry.meta.reasons
                    if (entry.meta.reasons.length === 0) {
                        cb(entry.action, entry.meta)
                        await (await this.os('log', 'write')).delete!(entry.seq)
                    } else {
                        await (await this.os('log', 'write')).put!(entry)
                    }
                }
            }
        } else {
            const log = await this.os('log', 'write')
            const request = log.index('reasons').openCursor(reason)
            await new Promise((resolve, reject) => {
                request.onsuccess = (ev) => {
                    // @ts-expect-error Why TS failing?
                    if (!ev.target!.result) return resolve()
                    const entry = request.result!.value
                    const m = entry.meta
                    const c = criteria

                    if (isDefined(c.olderThan) && !isFirstOlder(m, c.olderThan!)) {
                        request.result?.continue()
                    }
                    if (
                        isDefined(c.youngerThan) &&
                        !isFirstOlder(c.youngerThan!, m)
                    ) {
                        request.result?.continue()
                        return
                    }
                    if (isDefined(c.minAdded) && entry.added < c.minAdded!) {
                        request.result?.continue()
                        return
                    }
                    if (isDefined(c.maxAdded) && entry.added > c.maxAdded!) {
                        request.result?.continue()
                    }

                    entry.reasons = entry.reasons.filter(i => i !== reason)
                    entry.meta.reasons = entry.reasons

                    let process:IDBRequest
                    if (entry.reasons.length === 0) {
                        entry.meta.added = entry.added
                        cb(entry.action, entry.meta)
                        process = log.delete(entry.added)
                    } else {
                        process = log.put(entry)
                    }

                    process.onerror = err => reject(err)
                    process.onsuccess = () => process.result.continue()
                }
            })
        }
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

function isDefined (value:any) {
    return typeof value !== 'undefined'
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
    firstMeta:Partial<MetaData>|string,
    secondMeta:Partial<MetaData>|string
):boolean {
    if (typeof firstMeta === 'string') {
        firstMeta = { id: firstMeta, time: parseInt(firstMeta) }
    }
    if (typeof secondMeta === 'string') {
        secondMeta = { id: secondMeta, time: parseInt(secondMeta) }
    }

    if (firstMeta.time! > secondMeta.time!) {
        return false
    } else if (firstMeta.time! < secondMeta.time!) {
        return true
    }

    const firstID = firstMeta.id!.split(' ')
    const secondID = secondMeta.id!.split(' ')

    const firstNode = firstID[1]
    const secondNode = secondID[1]
    if (firstNode > secondNode) {
        return false
    } else if (firstNode < secondNode) {
        return true
    }

    const firstCounter = parseInt(firstID[2])
    const secondCounter = parseInt(secondID[2])
    if (firstCounter > secondCounter) {
        return false
    } else if (firstCounter < secondCounter) {
        return true
    }

    const firstNodeTime = parseInt(firstID[0])
    const secondNodeTime = parseInt(secondID[0])
    if (firstNodeTime > secondNodeTime) {
        return false
    } else if (firstNodeTime < secondNodeTime) {
        return true
    }

    return false
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
