import assert from "node:assert/strict"
import test from "node:test"
import { PassThrough } from "node:stream"
import { render } from "ink"
import { useState } from "react"
import { TextInput } from "./text-input.js"

function harness() {
  // Mirror the screens.test mount: ink needs a ref/unref-capable raw-mode stdin.
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin }) as unknown as NodeJS.ReadStream
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
  return { stdin, stdout }
}

function Probe({ submitted, onChange }: { submitted: (value: string) => void; onChange: (value: string) => void }) {
  const [value, setValue] = useState("")
  return <TextInput value={value} onChange={(next) => { setValue(next); onChange(next) }} onSubmit={submitted} />
}

test("a return inside one input chunk still submits the line", async () => {
  const { stdin, stdout } = harness()
  const submitted: string[] = []
  const { unmount } = render(<Probe submitted={(v) => submitted.push(v)} onChange={() => {}} />, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  stdin.write("/a\r")
  await new Promise((resolve) => setTimeout(resolve, 50))
  unmount()
  assert.deepEqual(submitted, ["/a"])
})

test("a pasted two-line chunk submits both lines", async () => {
  const { stdin, stdout } = harness()
  const submitted: string[] = []
  const { unmount } = render(<Probe submitted={(v) => submitted.push(v)} onChange={() => {}} />, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  stdin.write("first\nsecond\n")
  await new Promise((resolve) => setTimeout(resolve, 50))
  unmount()
  assert.deepEqual(submitted, ["first", "second"])
})

test("plain typing still accumulates without submitting", async () => {
  const { stdin, stdout } = harness()
  const submitted: string[] = []
  const values: string[] = []
  const { unmount } = render(<Probe submitted={(v) => submitted.push(v)} onChange={(v) => values.push(v)} />, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  stdin.write("ab"); stdin.write("c")
  await new Promise((resolve) => setTimeout(resolve, 50))
  unmount()
  assert.deepEqual(submitted, [])
  assert.equal(values.at(-1), "abc")
})
