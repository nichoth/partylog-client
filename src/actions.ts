export interface Metadata {
    id:string,  // hash of the metadata
    timestamp: number,
    proof:string,  // hash of the (unencrypted) content
    seq:number,
    prev:string|null,
    username:string,
    type:'post'|'private'
}

export type Message = {
    metadata:Metadata,
    content:string  // stringified & encrypted JSON object
}

/**
 * Actions for a general sync protocol.
 *
 * 'add' is adding a single message.
 * 'sync' means you are pushing an array of messages.
 * 'hello' is a message with the latest `seq` string we have.
 * 'remove' is the message ID to delete.
 */
export type Actions = {
    add: ['add', body:Message];
    /**
     * { since } is the `seq` string before the one starting in `messages`
     */
    sync: ['sync', body:{ since:string, messages:Message[] }];
    hello: ['hello', body:{ lastAdded:string, messages?:Message[] }];
    remove: ['remove', body:{ id:string }]
}

export type AnyAction =
    | Actions['add']
    | Actions['sync']
    | Actions['hello']
    | Actions['remove']

/**
 * Create an action to add a single message
 * @param {Message} body The message
 * @returns {Actions['add']}
 */
export function AddAction (msg:Message):Actions['add'] {
    return ['add', msg]
}

/**
 * Server gets 'hello' message from client, and the client's `last_added`
 * number is even with its `last_synced` number (they have not added any new
 * messages).
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
 * @param {string} latest The latest `seq` string you have
 * @param {Message[]} newMsgs The difference between `last_added`
 * and `last_synced` (the new messages).
 * @returns {Actions['hello']}
 */
export function HelloAction (
    latest:string,
    newMsgs?:Message[]
):Actions['hello'] {
    return ['hello', { lastAdded: latest, messages: newMsgs }]
}

/**
 * Create a 'sync' action.
 *
 * @param since The `seq` string of the message before the ones we are sending
 * @param body Array of messages
 * @returns {Actions['sync']}
 */
export function SyncAction (since:string, body:Message[]):Actions['sync'] {
    return ['sync', { since, messages: body }]
}

export interface Action<T = void> {
    type:string;
    data:T;
    meta:Metadata;
    error?:boolean;
}

export interface ActionCreator<T> {
    type: string;
    match: (action:Action<T>) => action is Action<T>;

    /**
     * Creates action with given payload and metadata.
     *
     * @param payload Action payload.
     * @param meta Action metadata. Merged with `commonMeta` of Action Creator.
     */
    (payload:T, meta?:Metadata):Action<T>;
}

export interface IActionCreatorFactory {
    /**
     * Creates Action Creator that produces actions with given `type` and
     * payload of type `Payload`.
     *
     * @param type Type of created actions.
     * @param commonMeta Metadata added to created actions.
     * @param isError Defines whether created actions are error actions.
     */
    <T = void>(
      type:string,
      commonMeta?:Metadata,
      isError?:boolean,
    ):ActionCreator<T>;

    /**
     * Creates Action Creator that produces actions with given `type` and payload
     * of type `Payload`.
     *
     * @param type Type of created actions.
     * @param commonMeta Metadata added to created actions.
     * @param isError Function that detects whether action is error given the
     *   payload.
     */
    <T = void>(
      type:string,
      commonMeta?:Metadata,
      isError?:(payload:T) => boolean,
    ):ActionCreator<T>;
}

/**
 * Creates Action Creators with optional prefix for action types.
 *
 * @param prefix Prefix to be prepended to action types as `<prefix>/<type>`.
 * @param defaultIsError Function that detects whether action is error given the
 *   payload. Default is `payload => payload instanceof Error`.
 */
export function ActionCreatorFactory (
    prefix?:string|null,
    defaultIsError:(payload:any) => boolean = p => p instanceof Error,
):IActionCreatorFactory {
    const actionTypes:{[type:string]:boolean} = {}

    const base = prefix ? `${prefix}/` : ''

    function actionCreator<Payload> (
        type:string,
        commonMeta?:Metadata,
        isError:((payload:Payload) => boolean)|boolean = defaultIsError,
    ) {
        const fullType = base + type

        if (!import.meta.env.PROD) {
            if (actionTypes[fullType]) {
                throw new Error(`Duplicate action type: ${fullType}`)
            }

            actionTypes[fullType] = true
        }

        return Object.assign(
            (payload:Payload, meta?:Metadata) => {
                const action:Partial<Action<Payload>> = {
                    type: fullType,
                    data: payload,
                }

                if (commonMeta || meta) {
                    action.meta = Object.assign({}, commonMeta, meta)
                }

                if (isError && (typeof isError === 'boolean' || isError(payload))) {
                    action.error = true
                }

                return (action as Action<Payload>)
            },
            {
                type: fullType,
                toString: () => fullType,
                match: (action:Action<Payload>):action is Action<Payload> =>
                    action.type === fullType,
            },
        ) as ActionCreator<Payload>
    }

    return actionCreator
}

const _createAction = ActionCreatorFactory()

export const ActionCreator = function<T> (type:string) {
    return _createAction<T>(type)
}
