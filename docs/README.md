# docs

## range queries
see [level + keys article](https://kevinsimper.medium.com/how-to-get-range-of-keys-in-leveldb-and-how-gt-and-lt-works-29a8f1e11782)

```js
const key = 'user:'
db.createReadStream({
  gte: key,
  lte: String.fromCharCode(key.charCodeAt(0) + 1)
})
```
