# AgentLoop edge Nginx

This configuration serves the Multi Runtime Web under `/agentloop/`. Run it on
the same Docker network as `agentloop-mr-web`. The Web server proxies `/api/`
to Router for browser requests, so only this Nginx port needs to be reachable
for the cloud Web workspace.

For the single-host `agentloop-mr` deployment, mount `agentloop.conf` at
`/etc/nginx/conf.d/default.conf` in an Nginx container attached to the
`agentloop-mr` network. Publish its port 80 on an approved host port. Validate
the configuration with `nginx -t` before starting or reloading the container.
Set `WEB_BASE_PATH=/agentloop` on the Web container so browser assets, links,
and same-origin Router API calls retain the prefix.

The proxy strips `/agentloop/` before forwarding to Web. Requests outside that
prefix return 404 from this dedicated Nginx instance.
