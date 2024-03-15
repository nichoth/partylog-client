# partylog client
![tests](https://github.com/bicycle-codes/partylog-client/actions/workflows/nodejs.yml/badge.svg)
[![semantic versioning](https://img.shields.io/badge/semver-2.0.0-blue?logo=semver&style=flat-square)](https://semver.org/)
[![module](https://img.shields.io/badge/module-ESM%2FCJS-blue?style=flat-square)](README.md)

A client-side log store

The Indexed DB database in the browser *is the source of truth*. The server
provides backup & state sync amongst multiple devices.

__Featuring__

* Leader election -- If you open multiple tabs to the same address, only a
  single websocket connection and a single database are creeated.

## the data format

We use actions and metadata. Actions are event-sourcing style -- something you
would pass to a `reduce` function.

## install

```sh
npm i -S @bicycle-codes/partylog-client
```

## use

## API
### IndexedStore

#### create a new store
Constructor takes an optional `name` parameter, which defaults to 'partylog'.

```ts
class IndexedStore {
    readonly name:string
    readonly adding:Record<string, boolean>
    readonly db:Promise<IDBDatabase>

    constructor (name = 'partylog')
```

```ts
import { test } from '@bicycle-codes/tapzero'
import { IndexedStore } from '@bicycle-codes/partylog-client/store'

test('IndexedStore', t => {
    store = new IndexedStore()
    t.ok(store, 'should create a store')
    t.equal(store.name, 'partylog', 'should have the default store name')
})
```

#### store.add
```ts
async add (
    action:AnyAction,
    meta:Partial<MetaData> = {}
):Promise<MetaData|null>
```

Add things to the store. This uses IndexedDB, because it's for browsers.

All the metadata is generated automatically.

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
Helpers to create action objects of various types.

Actions are JS objects like this:
```js
{
    type: 'user/rename',
    data: {
        name: 'alice',
        id: 'alice'
    }
}
```

#### ActionCreator
Create a function that will create actions of a given type.

```ts
const ActionCreator = function<T> (type:string)
```

##### example
```ts
import { test } from '@bicycle-codes/tapzero'
import { ActionCreator } from '@bicycle-codes/partylog-client/actions'

test('ActionCreator', t => {
    // create a factory function
    const renameUser = ActionCreator<{ id:string, name:string }>('user/rename')
    // create the action object
    const action = renameUser({ id: 'alice', name: 'alice' })

    t.deepEqual(action, {
        type: 'user/rename',
        data: {
            name: 'alice',
            id: 'alice'
        }
    }, 'should create the right action object')
})
```

#### match
The action creator function has a property `match` that will return `true` if a
given action has a matching `type`.

```js
test('action matcher', t => {
    t.equal(renameUser.match(action), true, 'should match a matching action')
    t.equal(renameUser.match({ type: 'user/rename' }), true,
        'shoudl match a matching object')
    t.equal(renameUser.match({ type: 'testing' }), false,
        'should not match a mismatched action object')
})
```

## Metadata

Metadata looks like this:

```js
// metadata
interface MetaData {
    seq:number;
    id:string;
    time:number;
    author:
}
```

## previous message format

```ts
{
  metadata: {
    seq: number,
    prev: string|null,  // <- hash of previous `metadata`
    username: string,
    timestamp: number,
    proof: string,   // <- a hash of the content
    signature: string,
    author: `did:key:z${string}`,  // <- the DID of the author device
  },
  content: {
    text:string,
    alt:string,
    mentions:string[]  // <- an array of hashes of blobs in this post
  }
}
```
