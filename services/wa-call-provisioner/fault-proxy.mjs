// A TCP-level fault proxy for tests: forwards each request to the upstream, and for requests it is told to "lose" it closes the client connection AFTER the
// upstream has answered. That is the lost-response case: the write happened, the caller never learns. `loseSequence` lists the paths whose responses are
// dropped, in order (e.g. lose the create answer AND the follow-up lookup). Keep-alive connections are handled: the path is read per request line.
import net from "node:net";

export function startFaultProxy({ upstreamPort, upstreamHost = "127.0.0.1" }) {
  const state = { queue: [], dropped: 0 };
  const server = net.createServer((client) => {
    const up = net.connect(upstreamPort, upstreamHost);
    let current = "";
    client.on("data", (d) => {
      const m = /^(?:POST|GET|PUT|DELETE|OPTIONS) (\S+) HTTP/.exec(d.toString("latin1").slice(0, 200));
      if (m) current = m[1];
      up.write(d);
    });
    up.on("data", (d) => {
      if (state.queue.length && current === state.queue[0]) { state.queue.shift(); state.dropped++; client.destroy(); up.destroy(); return; }
      client.write(d);
    });
    up.on("error", () => client.destroy()); client.on("error", () => up.destroy());
    client.on("close", () => up.destroy()); up.on("close", () => client.end());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port, state,
    loseSequence(paths) { state.queue = [...paths]; state.dropped = 0; },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
  })));
}
