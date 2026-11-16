# Shared conversation presentation

Desktop defines the conversation reading contract. These browser assets let Desktop and Multi Runtime use the same ordered process, collapsed tool details, schema-driven human input, and reading surface.

`process.js` renders public model segments and tool calls at their first event position. Streaming snapshots update a segment; lifecycle events update one tool row. Steer messages keep their chronological position even when the process is collapsed. Events remain owned by the Runtime.

`human-loop.js` renders and validates select, form, and confirm requests without selecting an answer. The same form DOM must survive updates for the same request ID and revision, including an in-flight response.

The hosts serve the assets at `/packages/agentloop-conversation-ui/`. Desktop packaging copies this directory into its bundled web assets. The modules contain no Router, Assignment, Run admission, credentials, or artifact transport logic. Each application adapts those boundaries itself.
