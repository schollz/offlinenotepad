
<p align="center">
<img
    src=""
    width="408px" border="0" alt="offlinenotepad">
<br>
<a href="https://github.com/schollz/offlinenotepad/releases/latest"><img src="https://img.shields.io/badge/version-v1.0.5-brightgreen.svg?style=flat-square" alt="Version"></a>
<a href="https://travis-ci.org/schollz/offlinenotepad"><img
src="https://img.shields.io/travis/schollz/offlinenotepad.svg?style=flat-square" alt="Build
Status"></a> 
</p>

<p align="center"><code><a href="https://offlinenotepad.com">https://offlinenotepad.com</a></code></p>

offlinenotepad is an open-source server for implementing a private, offline-first, minimalistic note-writing experience that can be accessed anywhere, anytime. 

**Offline-first.** All data and functions are available on the client. Storage uses localstorage, and there are client-side libraries for search and encryption.

**Secure.** offlinenotepad uses [crypto-js](https://github.com/brix/crypto-js) to encrypt data on the client using AES with the PBE algorithm (PBKDF2).

**Minimal.** This offline notepad aims to do as much as possible with as little as possible.

This writing tool is largely based of its predecessors: [cowyo](https://cowyo.com) and [rwtxt.com](https://rwtxt.com) (both also available on Github).

## Install

To run your own server for backing up notes you can simply install with Go.

```
$ git clone https://github.com/schollz/offlinenotepad
$ cd offlinenotepad
$ go build -v
```

And then you can run

```

$ ./offlinenotepad
```

Log into `localhost:8251` to see the site.

## Acknowledgements

I took a lot of help from @GoogleChromeLabs with their [airhorn](https://github.com/GoogleChromeLabs/airhorn).

## License

MIT
