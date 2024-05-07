export type DID = `did:key:z${string}`

/**
 * [timestamp, localSeq, deviceName]
 */
export type DeserializedSeq = readonly [
    timestamp:number,
    localSeq:number,
    deviceName:string
]

export interface Metadata {
    id:string,  // hash of the metadata
    timestamp:number,
    proof:string,  // hash of the (unencrypted) content
    seq:DeserializedSeq,
    localSeq:number,
    prev:string|null,
    username:string,
    deviceName:string,
    author:DID,
    scope:string
}

export interface SignedMetadata extends Metadata {
    signature:string
}

/**
 * This is for protocol messages.
 * Domain messages are `EncryptedMessage`
 */
export interface Action<T> {
    type:string;
    data:T
}

export type EncryptedMessage = {
    metadata:Metadata|SignedMetadata,
    content:string  // stringified & encrypted JSON object
}

export type UnencryptedMessage = {
    metadata:Metadata|SignedMetadata
    content:object  // `content` gets JSON stringified
}

/**
 * These are protocol messages. Protocol messages may contain a domain message.
 * Eg, 'add' message; the body is an encrypted message.
 *
 * 'add' is adding a single message.
 * 'hello' is a message with the latest `seq` string we have.
 * 'remove' is the message ID to delete.
 * 'edit' is an update request
 */
export type ProtocolActions = {
    add: ['add', body:EncryptedMessage|UnencryptedMessage];

    hello: [
        'hello',
        body:{
            localSeq:number
            messages?:UnencryptedMessage[]|EncryptedMessage[]
        }
    ];

    remove: ['remove', body:{ id:string }],

    /**
     * [
     *  'edit',
     *  { id:string, patch: { content: <JSON string of new content object> } }
     * ]
     */
    edit: [
        'edit',
        body:{
            id:string,
            // { content: <JSON string of new content> }
            patch:{ content:string }
        }
    ]
}

export type AnyProtocolAction =
    | ProtocolActions['add']
    | ProtocolActions['hello']
    | ProtocolActions['remove']
    | ProtocolActions['edit']

/**
 * Create an action to add a single message
 *
 * @param {Message} body The message
 * @returns {ProtocolActions['add']}
 */
export function AddAction (
    msg:EncryptedMessage|UnencryptedMessage
):ProtocolActions['add'] {
    return ['add', msg]
}

/**
 * Create an action to delete the given ID.
 * @param id The ID to remove
 * @returns {ProtocolActions['remove']} The action object
 */
export function RemoveAction (id:string):ProtocolActions['remove'] {
    return ['remove', { id }]
}

/**
 * Server gets 'hello' message from client, and the client's `last_added`
 * number is even with the client's `last_synced` number (they have not added
 * any new messages).
 *
 * *But* the server does have new messages. So we get the client's hello,
 * and it doesn't have any messages, just the last `seq` number that it has.
 *
 * We have a later `seq` number, so we send all the messages from their
 * `seq` in their 'hello' message to our most recent message.
 */

/**
 * Say hello, tell them what your most recent `seq` string is.
 * The client keeps track of the last synced message and the last locally
 * added message. If `last_added` is bigger than `last_synced`, then we
 * send the difference between `last_synced` and `last_added`.
 *
 * @param {string} latest The latest `seq` string for your messages
 * @param {Message[]} newMsgs The difference between `last_added`
 * and `last_synced` (the new messages).
 * @returns {ProtocolActions['hello']}
 */
export function HelloAction (
    lastAdded:number,
    newMsgs?:EncryptedMessage[]
):ProtocolActions['hello'] {
    return ['hello', { localSeq: lastAdded, messages: newMsgs }]
}
