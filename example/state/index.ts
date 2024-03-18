import { Signal, signal } from '@preact/signals'
import { program as createProgram } from '@oddjs/odd'
import { create as createIdentity, signAsString } from '@bicycle-codes/identity'
import { TokenFactory } from '@bicycle-codes/request'
import Route from 'route-event'
import {
    increment,
    decrement,
    ActionTypes,
    setCount
} from './actions.js'
import { CrossTabClient } from '../../src/cross-tab-client.js'
import Debug from '@nichoth/debug'
const debug = Debug()

/**
 * Setup
 *   - routes
 *   - logux subscription
 */
export async function State ():Promise<{
    route:Signal<string>;
    count:Signal<number>;
    username:Signal<string|null>;
    _client:InstanceType<typeof CrossTabClient>
    _setRoute:(path:string)=>void;
}> {  // eslint-disable-line indent
    const onRoute = Route()
    const program = await createProgram({
        namespace: { creator: 'test', name: 'testing' },
    })
    const { crypto } = program.components
    const keystore = crypto.keystore
    const createToken = TokenFactory(crypto)
    const token = await createToken()  // read & update `__seq` in localStorage

    const me = await createIdentity(crypto, { humanName: 'alice' })

    debug('Your DID -- ', me.rootDID)

    const client = new CrossTabClient({
        host: import.meta.env.DEV ?
            'localhost:1999' :  // local partykit server
            'partylog.nichoth.partykit.dev',
        userId: 'anonymous',
        did: me.rootDID,
        token,
        // we are signing our actions
        sign: (msg:string) => {
            return signAsString(keystore, msg)
        }
    })

    /**
     * What does the client do?
     *   - elect a leader tab, so there is 1 websocket connection
     *     per browser
     *   - handle new messages. When you create a new message,
     *     the client does 2 things:
     *       + write it to the local store,
     *       + send it to the server
     *   - handle sync. We don't want to think about sync in the app domain
     *
     * It is the interface to the store + websocket.
     */

    /**
     * @TODO
     * Subscribe to changes
     */

    debug('the client', client)

    const state = {
        _setRoute: onRoute.setRoute.bind(onRoute),
        _client: client,
        username: signal<string|null>(null),
        count: signal<number>(0),
        route: signal<string>(location.pathname + location.search)
    }

    if (import.meta.env.DEV || import.meta.env.MODE === 'staging') {
        // @ts-expect-error dev env
        window.state = state

        // @ts-expect-error dev
        window.clearLogux = async function () {
            const dbNames = (await indexedDB.databases())
                .map(db => db.name)
                .filter(name => name!.includes('partylog'))

            dbNames.forEach(name => {
                indexedDB.deleteDatabase(name as string)
            })

            let l = localStorage.length
            while (l--) {
                const key = localStorage.key(l)
                if (key!.includes('partylog')) {
                    localStorage.removeItem(key!)
                }
            }
        }
    }

    if (import.meta.env.DEV) {
        // @ts-expect-error for DEV
        window.client = client
    }

    /**
     * Here we process the actions
     */
    client.on('add', (action) => {
        // this is an action that we added locally
        // (not something added by another device)
        debug('got "add" event', action)

        if (!(ActionTypes[action.type])) {
            // then this is not something we care about
            return
        }

        /**
         * @TODO -- how to get types for the action?
         */
        if (setCount.match(action)) {
            debug('**count/set**', action.data!.value)
            state.count.value = action.data!.value
        }

        if (decrement.match(action)) {
            debug('count/decrement', action)
            state.count.value--
        }

        if (increment.match(action)) {
            debug('count/increment', action)
            state.count.value++
        }
    })

    /**
     * Handle route changes
     */
    onRoute((path:string, data) => {
        const newPath = path.replace('/logux-party/', '/')  // <- for github pages
        state.route.value = newPath
        // handle scroll state like a web browser
        // (restore scroll position on back/forward)
        if (data.popstate) {
            return window.scrollTo(data.scrollX, data.scrollY)
        }
        // if this was a link click (not back button), then scroll to top
        window.scrollTo(0, 0)
    })

    return state
}

State.Increase = async function (state:Awaited<ReturnType<typeof State>>) {
    const inc = increment()
    debug('increment action', inc)
    // const meta = await state._client.log.add(inc, { sync: true })
    const meta = state._client.add(inc)
    debug('the increment meta', meta)
}

State.Decrease = async function (state:Awaited<ReturnType<typeof State>>) {
    const dec = decrement()
    debug('decrement action', dec)
    state._client.add(dec, { sync: true })

    // for the old logux client:
    // await state._client.log.add(dec, { sync: true })
    // add to the log, but don't sync:
    // state._client.log.add(dec, { sync: false })
}
