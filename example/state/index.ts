import { Signal, signal } from '@preact/signals'
import { program as createProgram } from '@oddjs/odd'
import { create as createIdentity } from '@bicycle-codes/identity'
import { TokenFactory } from '@bicycle-codes/request'
import Route from 'route-event'
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
    const createToken = TokenFactory(crypto)
    const token = await createToken()  // read & update `__seq` in localStorage
    const me = await createIdentity(crypto, { humanName: 'alice' })

    debug('Your DID -- ', me.rootDID)

    const client = await CrossTabClient.create({
        did: me.rootDID,
        token,
        host: import.meta.env.DEV ?
            'localhost:1999' :  // local partykit server
            'partylog.nichoth.partykit.dev',
    })

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
        window.clearIDB = async function () {
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

        // @ts-expect-error for DEV
        window.client = client
    }

    /**
     * Here, process the domain actions
     */
    client.on('add', (action) => {
        // this is an action that we added locally
        // (not something added by another device)
        debug('got "add" event', action)
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
    const meta = state._client.add({ type: 'increment' }, { scope: 'private' })
    debug('incrementing...', meta)
}

State.Decrease = async function (state:Awaited<ReturnType<typeof State>>) {
    const meta = state._client.add({ type: 'decrement' }, { scope: 'private' })
    debug('decrementing...', meta)
}
