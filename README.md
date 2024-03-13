# partylog client
![tests](https://github.com/bicycle-codes/partylog-client/actions/workflows/nodejs.yml/badge.svg)
[![types](https://img.shields.io/npm/types/@bicycle-codes/party-log-client?style=flat-square)](README.md)
[![module](https://img.shields.io/badge/module-ESM%2FCJS-blue?style=flat-square)](README.md)

Client-side log store

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
import { IndexedStore } from '@bicycle-codes/partylog-client'

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
import { IndexedStore, MetaData } from '@bicycle-codes/partylog-client'

const store = new IndexedStore()

let meta1:MetaData|false
test('add something to the store', async t => {
    meta1 = await store.add({ type: 'test' })
    t.ok(meta1, 'should create metadata')
    t.ok((meta1 as MetaData).id, 'should return metadata with an ID')
    t.equal((meta1 as MetaData).seq, 1, 'should have the right sequence number')

    const meta2 = await store.add({ type: 'testing' }, { seq: 7 })
    t.equal((meta2 as MetaData).seq, 2,
        'should overwrite the sequence I passed in')
})
```
