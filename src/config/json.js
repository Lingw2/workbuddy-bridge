/**
 * Small helpers for reading and writing JSON files.
 *
 * Some of the files we touch were written by other tools and carry a UTF-8
 * byte order mark, which `JSON.parse` rejects. The helpers here strip it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Read a JSON file, tolerating a byte order mark. */
export function readJsonFile(path, fallback = null) {
  if (!existsSync(path)) return fallback
  try {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Write a JSON file with a trailing newline. */
export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
