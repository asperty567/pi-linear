export function jsonToolResult(value: unknown) {
  const output = JSON.stringify(value, null, 2);
  const lines = output.split("\n");
  let text = lines.length > 2_000
    ? `${lines.slice(0, 2_000).join("\n")}\n[Output truncated at 2,000 lines]`
    : output;
  if (Buffer.byteLength(text, "utf8") > 50_000) {
    text = `${Buffer.from(text, "utf8").subarray(0, 49_900).toString("utf8")}\n[Output truncated at 50KB]`;
  }
  return { content: [{ type: "text" as const, text }], details: value };
}
