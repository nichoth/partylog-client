# indexed DB

[See an example app](https://github.com/mdn/dom-examples/blob/main/indexeddb-api/main.js)

## [IndexedDB key characteristics and basic terminology](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology)

> IndexedDB lets you store and retrieve objects that are indexed with a "key."

### All changes happen within transactions.

* cannot execute commands or open cursors outside of a transaction

* same-origin policy


### key-value pairs

* key-value pairs -- The values can be complex data like objects.
  - Can create indexes that use any property of the objects for quick searching
    or sorted enumeration.

### uses requests

> Requests are objects that receive the success or failure DOM events

* have `onsuccess`, `onerror` properties
  - The `result` property is particularly magical. It can be many different
    things.

### object oriented vs relational

> IndexedDB, on the other hand, requires you to create an object store for a
  type of data and persist JavaScript objects to that store

### index

> An index is a specialized object store for looking up records in another
> object store

vs

### [key](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology#key)

> The object store can derive the key from one of three sources: a [key generator](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology#key_generator), a [key path](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology#key_path), or an explicitly specified value.

> in web development, you don't really create or access key generators.

> Each record in an object store must have a key that is unique within the same store

[see stackoverflow](https://stackoverflow.com/questions/32214815/indexeddb-what-is-key-keypath-and-indexname)

>  key is like a primary key in SQL

> Indexes are used to search that "column" in the database.

> For example, suppose your data has the column `hours` and you want to be able to search your database on that column. When creating your database you would create an index for that column:

```js
objectStore.createIndex("hoursColumn", "hours", { unique: false });
```

> I can write data to the objectStore as follows:

```js
db.transaction(storeName, "readwrite").objectStore(storeName).add({
    hours: 20,
    minutes: 30
});
```

> to search your data on the column hours, you could write:

```js
var data = db.transaction(storeName)
    .objectStore(storeName)
    .index("hoursColumn")
    .get(20)
```

> the result would be the first row of data where hours = 20, e.g. `{ hours: 20, minutes: 30 }`

## indexes vs `keyPath`

[See stackoverflow](https://stackoverflow.com/questions/31908605/indexeddb-is-keypath-already-an-index)

> It doesn't technically create an index, but it's basically the same thing.

## the basic pattern

[The Basic Pattern](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#basic_pattern)

1. open the DB

```js
// Let us open our database
// ("DB name", DB version)
const request = window.indexedDB.open("MyTestDatabase", 1);
```

> The call to the open() function returns an [IDBOpenDBRequest](https://developer.mozilla.org/en-US/docs/Web/API/IDBOpenDBRequest) object

> The version of the database determines the database schema — the object stores in the database and their structure.

> The first thing you'll want to do with almost all of the requests you generate is to add success and error handlers:

```js
request.onerror = (event) => {
  // Do something with request.errorCode!
};
request.onsuccess = (event) => {
  // Do something with request.result!
};
```

> request.result is an instance of IDBDatabase, and you definitely want to save that for later.

```js
let db;
const request = indexedDB.open("MyTestDatabase");
request.onerror = (event) => {
  console.error("Why didn't you allow my web app to use IndexedDB?!");
};
request.onsuccess = (event) => {
  db = event.target.result;
};
```

## structure

> Now to structure the database. IndexedDB uses object stores rather than tables, and a single database can contain any number of object stores.

[Adding data](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#adding_data_to_the_database)

> The result of a request generated from a call to add() is the key of the value that was added.

Each `objectStore` has a key.

The `add()` function requires that the key for the added item is unique.

> If you're trying to modify an existing entry, or you don't care if one exists already, you can use the `put()` function

## retrieve data

### the simple `get()`

Provide the key to retrieve the value

```js
const transaction = db.transaction(["customers"]);
const objectStore = transaction.objectStore("customers");
// here the key is the SSN
const request = objectStore.get("444-44-4444");
```

or

```js
db
  .transaction("customers")
  .objectStore("customers")
  .get("444-44-4444").onsuccess = (event) => {
    console.log(`Name for SSN 444-44-4444 is ${event.target.result.name}`);
  }
```

### [cursor](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#using_a_cursor)

```js
const objectStore = db.transaction("customers").objectStore("customers");

objectStore.openCursor().onsuccess = (event) => {
  const cursor = event.target.result;
  if (cursor) {
    console.log(`Name for SSN ${cursor.key} is ${cursor.value.name}`);
    cursor.continue();
  } else {
    console.log("No more entries!");
  }
};
```

Several possible arguments to `openCursor`

1. you can limit the range of items that are retrieved by using a key range object
2. you can specify the direction that you want to iterate

The above example iterates over all objects in ascending order.

__Retrieve all objects in an object store and add them to an array:__

```js
const customers = [];

objectStore.openCursor().onsuccess = (event) => {
  const cursor = event.target.result;
  if (cursor) {
    customers.push(cursor.value);
    cursor.continue();
  } else {
    console.log(`Got all customers: ${customers}`);
  }
};
```

> !NOTE
> `keyCurosr` vs regular cursor
> A normal cursor maps the index property to the object in the object store.
> A key cursor maps the index property to the key used to store the object in
> the object store.

```js
// Using a key cursor to grab customer record object keys
index.openKeyCursor().onsuccess = (event) => {
  const cursor = event.target.result;
  if (cursor) {
    // cursor.key is a name, like "Bill", and cursor.value is the SSN.
    // No way to directly get the rest of the stored object.
    console.log(`Name: ${cursor.key}, SSN: ${cursor.primaryKey}`);
    cursor.continue();
  }
};
```

## [range queries](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#specifying_the_range_and_direction_of_cursors)

> use an [IDBKeyRange](https://developer.mozilla.org/en-US/docs/Web/API/IDBKeyRange) object

```js
// Match anything between "Bill" and "Donna", but not including "Donna"
const boundKeyRange = IDBKeyRange.bound("Bill", "Donna", false, true);
```

To use one of the key ranges, pass it in as the first argument of
`openCursor()` or `openKeyCursor()`

```js
index.openCursor(boundKeyRange).onsuccess = (event) => {
  const cursor = event.target.result;
  if (cursor) {
    // Do something with the matches.
    cursor.continue();
  }
};
```

### iterate in descending order

pass `prev`

```js
objectStore.openCursor(boundKeyRange, "prev").onsuccess = (event) => {
  const cursor = event.target.result;
  if (cursor) {
    // Do something with the entries.
    cursor.continue();
  }
};
```

## charwise
Can use arrays as keys.

### See [charwise](https://github.com/dominictarr/charwise)

```js
const db = level('./db', {
  keyEncoding: charwise
})

await db.batch([
  { type: 'put', key: ['users', 2], value: 'example' },
  { type: 'put', key: ['users', 10], value: 'example2' }
])

const userStream = db.createStream({
  gte: ['users', charwise.LO],
  lte: ['users', charwise.HI]
})
```
