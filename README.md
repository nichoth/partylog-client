# partylog client
![tests](https://github.com/bicycle-codes/partylog-client/actions/workflows/nodejs.yml/badge.svg)
[![types](https://img.shields.io/npm/types/@bicycle-codes/party-log-client?style=flat-square)](README.md)
[![module](https://img.shields.io/badge/module-ESM%2FCJS-blue?style=flat-square)](README.md)

Client-side log store

__the data format__
We use actions and metadata. Actions are in the event-sourcing meaning of the
word -- something you would pass to a `reduce` function.

```js
// action
export const renameUser = createAction<{
    userId:string,
    name:string
}>('user/rename')
const rename = {
}
```

```js
{
    "type": "user/rename",
    "payload": {
        "foo": "bar"
    }
}
```

```js
// metadata
export interface MetaData {
    seq:number
    id:string
    reasons:string[]
    subprotocol?:string
    time:number
}
```

## install

```sh
npm i -S @bicycle-codes/partylog-client
```

## use

### IndexedStore

#### create a new store
Constructor takes an optional `name` parameter, which defaults to 'logparty'.

```ts
class IndexedStore {
    name:string
    adding:Record<string, boolean>
    db:Promise<IDBDatabase>

constructor (name = 'logparty')
```

```ts
import { test } from '@bicycle-codes/tapzero'
import { IndexedStore } from '@bicycle-codes/partylog-client/store'

test('IndexedStore', t => {
    store = new IndexedStore()
    t.ok(store, 'should create a store')
    t.equal(store.name, 'logparty', 'should have the default store name')
})
```

#### store.add
```ts
async add (
    action:AnyAction,
    meta:Partial<MetaData> = {}
):Promise<MetaData|null>
```

Add things to the store. This uses IndexedDB because it's for browsers.

If the ID already exists, the operation will fail, in which case `null` will
be returned. (It's not really possible to have an ID conflict though. The IDs
are hashes of the message, and every message has unique content, because an
incrementing integer is added to each one.)

```ts
import { test } from '@bicycle-codes/tapzero'
import { IndexedStore, MetaData } from '@bicycle-codes/partylog-client/store'

const store = new IndexedStore()

let meta1:MetaData|null
test('add something to the store', async t => {
    meta1 = await store.add({ type: 'test' })
    t.ok(meta1, 'should create metadata')
    t.ok(meta1!.id, 'should return metadata with an ID')
    t.equal(meta1!.seq, 1, 'should have the right sequence number')

    const meta2 = await store.add({ type: 'testing' }, { seq: 7 })
    t.equal((meta2 as MetaData).seq, 2,
        'should overwrite the sequence number I passed in')
})
```

### Actions

A helper to create action objects of various types.

#### ActionCreatorFactory

##### API
```ts
function ActionCreatorFactory (
    prefix?:string|null,
    defaultIsError:(payload:any) => boolean = p => p instanceof Error,
):IActionCreatorFactory
```

##### example
```ts
import { ActionCreatorFactory } from '@bicycle-codes/partylog-client/actions'

const createAction = ActionCreatorFactory()
const renameUser = createAction<{
    userId:string,
    name:string
}>('user/rename')

const action = renameUser({ userId: 'alice', name: 'alice' })
/*
=> {
  "type": "user/rename",
  "payload": {
    "userId": "alice",
    "name": "alice"
  }
}
*/
```

