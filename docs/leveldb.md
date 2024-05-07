# level DB

## secondary indexes

[See docs](https://github.com/Level/abstract-level?tab=readme-ov-file#dbbatchoperations-options)

Values are indexed by `key`. Use `sublevel` for a secondary index.

[See sublevel docs](https://github.com/Level/abstract-level?tab=readme-ov-file#sublevel)

The first value will be encoded with `json` rather than the default encoding
of `db`:

```js
const people = db.sublevel('people', { valueEncoding: 'json' })
const nameIndex = db.sublevel('names')

await db.batch([{
  type: 'put',
  sublevel: people,
  key: '123',
  value: {
    name: 'Alice'
  }
}, {
  type: 'put',
  sublevel: nameIndex,
  key: 'Alice',
  value: '123'
}])
```


------------------------------------------------------------------


[levelDB transcoder.encoding docs](https://github.com/Level/transcoder/blob/main/index.js#L51)

