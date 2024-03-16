import { html } from 'htm/preact'
import { FunctionComponent, render } from 'preact'
import Debug from '@nichoth/debug'
import { State } from './state/index.js'
const debug = Debug()

const state = await State()
if (import.meta.env.DEV) {
    // @ts-expect-error  b/c testing
    window.state = state
}

const Example:FunctionComponent<{
    state: Awaited<ReturnType<typeof State>>
}> = function Example ({ state }) {
    debug('redering...', state)
    return html`<div>hello</div>`
}

render(html`<${Example} />`, document.getElementById('root')!)
