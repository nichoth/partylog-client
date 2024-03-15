import { html } from 'htm/preact'
import { FunctionComponent, render } from 'preact'

const Example:FunctionComponent = function Example () {
    return html`<div>hello</div>`
}

render(html`<${Example} />`, document.getElementById('root')!)
