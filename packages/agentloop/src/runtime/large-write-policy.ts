/**
 * Keep authored file writes below the model's single-response budget.  This is
 * a character bound because the model emits JSON tool arguments, where the
 * provider token cost is affected by escaping and protocol overhead.
 */
export const LARGE_WRITE_CHUNK_CHARACTERS = 6_000;

export const LARGE_WRITE_DISCIPLINE = [
  `For computer_write_file content larger than ${LARGE_WRITE_CHUNK_CHARACTERS} characters, a single tool call is forbidden: use the bounded create-then-append protocol.`,
  `Write the first chunk with mode="create", then wait for its receipt before sending each subsequent ${LARGE_WRITE_CHUNK_CHARACTERS}-character-or-smaller chunk with mode="append" to the same path.`,
  "Split authored JSON, source, or markup at semantic boundaries such as objects, slides, sections, or functions; never emit one giant inline content argument.",
  "After the final append, use the returned final byte count and sha256 as the write receipt and proceed to the normal artifact verification boundary; do not reread the entire file solely because earlier chunks were omitted from context.",
].join(" ");
