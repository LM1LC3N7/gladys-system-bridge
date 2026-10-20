# Third-party notices

This integration ports to JavaScript the protocol logic of the projects below
for talking to System Bridge: the WebSocket at `ws://<host>:<port>/api/websocket`
(port 9170 by default), one JSON message `{ token, id, event, data }` per
request, `GET_DATA` answered by `DATA_GET` then one `DATA_UPDATE` per module,
the `POWER_*` and `OPEN` events and their answers, the `BAD_TOKEN` error, and
the shapes of the `system`, `cpu`, `memory`, `disks`, `battery` and `gpus`
modules. Nothing of them is installed at runtime, and no line is copied: they
are Python and Go, this integration is JavaScript (`src/bridge/client.js`,
`src/bridge/parse.js`). The WebSocket client (`src/bridge/ws.js`) is written
from RFC 6455.

## timmo001/system-bridge-connector

<https://github.com/timmo001/system-bridge-connector> (read at commit
`1f85a7f`, 2026-10-09; the `systembridgeconnector` package used by Home
Assistant), licensed under the Apache License, Version 2.0. The project ships
no NOTICE file. The full text of the license is the `LICENSE` file of this
repository (the same Apache License 2.0).

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## timmo001/system-bridge

<https://github.com/timmo001/system-bridge> (the System Bridge application
itself, read at commit `d0e1b35`, 2026-10-20, to check the answers of its
WebSocket server and the JSON names of its data types), licensed under the
Apache License, Version 2.0. The project ships no NOTICE file. The license is
the same as above.

## LM1LC3N7/gladys-portainer

The structure of the app, the handler wiring, the retry and pause policy, the
persistent store and the command safety rules follow this integration of the
same author, under the Apache License 2.0 of this repository.
