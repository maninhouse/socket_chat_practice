const express = require("express");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { availableParallelism } = require("node:os");
const cluster = require("node:cluster");
const { createAdapter, setupPrimary } = require("@socket.io/cluster-adapter");

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  // create one worker per available core
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }

  // set up the adapter on the primary thread
  return setupPrimary();
}

async function main() {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_offset TEXT UNIQUE,
            content TEXT
        );
      `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    // set up the adapter on each worker thread
    adapter: createAdapter(),
  });

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });

  io.on("connection", async (socket) => {
    socket.on("disconnect", async () => {
      console.log("user disconnected");
    });

    socket.on("clear", async (callback) => {
      try {
        result = await db.run("DELETE FROM messages");
      } catch (e) {
        console.log("checkpoint 0");
        console.error(e);
      }
      console.log(result);
      callback();
    });

    socket.on("chat message", async (msg, clientOffset, callback) => {
      let result;
      try {
        result = await db.run(
          "INSERT INTO messages (content, client_offset) VALUES (?, ?)",
          msg,
          clientOffset,
        );
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          console.log("checkpoint 1");
          console.log(`msg:${msg} clientOffset:${clientOffset}`);
          console.error(e);
          // the message was already inserted, so we notify the client
          callback();
        } else {
          // nothing to do, just let the client retry
          console.log("checkpoint 2");
          console.error(e);
        }
        return;
      }
      // console.log('message: ' + msg);
      // socket.broadcast.emit(msg);
      io.emit("chat message", msg, result.lastID);
      callback();
    });

    if (!socket.recovered) {
      // if the connection state recovery was not successful
      try {
        await db.each(
          "SELECT id, content FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit("chat message", row.content, row.id);
          },
        );
      } catch (e) {
        // something went wrong
        console.log("checkpoint 3");
        console.error(e);
      }
    }
  });

  // each worker will listen on a distinct port
  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });

  // server.listen(3000, () => {
  //     console.log('server is running at http://localhost:3000');
  // });
}

main();
