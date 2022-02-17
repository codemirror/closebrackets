import {EditorView, KeyBinding} from "@codemirror/view"
import {EditorState, EditorSelection, Transaction, Extension,
        StateCommand, StateField, StateEffect, MapMode, CharCategory} from "@codemirror/state"
import {RangeSet, RangeValue} from "@codemirror/rangeset"
import {Text, codePointAt, fromCodePoint, codePointSize} from "@codemirror/text"
import {syntaxTree} from "@codemirror/language"

/// Configures bracket closing behavior for a syntax (via
/// [language data](#state.EditorState.languageDataAt)) using the `"closeBrackets"`
/// identifier.
export interface CloseBracketConfig {
  /// The opening brackets to close. Defaults to `["(", "[", "{", "'",
  /// '"']`. Brackets may be single characters or a triple of quotes
  /// (as in `"''''"`).
  brackets?: string[],
  /// Characters in front of which newly opened brackets are
  /// automatically closed. Closing always happens in front of
  /// whitespace. Defaults to `")]}'\":;>"`.
  before?: string
}

const defaults: Required<CloseBracketConfig> = {
  brackets: ["(", "[", "{", "'", '"'],
  before: ")]}'\":;>"
}

const closeBracketEffect = StateEffect.define<number>({
  map(value, mapping) {
    let mapped = mapping.mapPos(value, -1, MapMode.TrackAfter)
    return mapped == null ? undefined : mapped
  }
})
const skipBracketEffect = StateEffect.define<number>({
  map(value, mapping) { return mapping.mapPos(value) }
})

const closedBracket = new class extends RangeValue {}
closedBracket.startSide = 1; closedBracket.endSide = -1

const bracketState = StateField.define<RangeSet<typeof closedBracket>>({
  create() { return RangeSet.empty },
  update(value, tr) {
    if (tr.selection) {
      let lineStart = tr.state.doc.lineAt(tr.selection.main.head).from
      let prevLineStart = tr.startState.doc.lineAt(tr.startState.selection.main.head).from
      if (lineStart != tr.changes.mapPos(prevLineStart, -1))
        value = RangeSet.empty
    }
    value = value.map(tr.changes)
    for (let effect of tr.effects) {
      if (effect.is(closeBracketEffect)) value = value.update({add: [closedBracket.range(effect.value, effect.value + 1)]})
      else if (effect.is(skipBracketEffect)) value = value.update({filter: from => from != effect.value})
    }
    return value
  }
})

/// Extension to enable bracket-closing behavior. When a closeable
/// bracket is typed, its closing bracket is immediately inserted
/// after the cursor. When closing a bracket directly in front of a
/// closing bracket inserted by the extension, the cursor moves over
/// that bracket.
export function closeBrackets(): Extension {
  return [inputHandler, bracketState]
}

const definedClosing = "()[]{}<>"

function closing(ch: number) {
  for (let i = 0; i < definedClosing.length; i += 2)
    if (definedClosing.charCodeAt(i) == ch) return definedClosing.charAt(i + 1)
  return fromCodePoint(ch < 128 ? ch : ch + 1)
}

function config(state: EditorState, pos: number) {
  return state.languageDataAt<CloseBracketConfig>("closeBrackets", pos)[0] || defaults
}

const android = typeof navigator == "object" && /Android\b/.test(navigator.userAgent)

const inputHandler = EditorView.inputHandler.of((view, from, to, insert) => {
  if ((android ? view.composing : view.compositionStarted) || view.state.readOnly) return false
  let sel = view.state.selection.main
  if (insert.length > 2 || insert.length == 2 && codePointSize(codePointAt(insert, 0)) == 1 ||
      from != sel.from || to != sel.to) return false
  let tr = insertBracket(view.state, insert)
  if (!tr) return false
  view.dispatch(tr)
  return true
})

/// Command that implements deleting a pair of matching brackets when
/// the cursor is between them.
export const deleteBracketPair: StateCommand = ({state, dispatch}) => {
  if (state.readOnly) return false
  let conf = config(state, state.selection.main.head)
  let tokens = conf.brackets || defaults.brackets
  let dont = null, changes = state.changeByRange(range => {
    if (range.empty) {
      let before = prevChar(state.doc, range.head)
      for (let token of tokens) {
        if (token == before && nextChar(state.doc, range.head) == closing(codePointAt(token, 0)))
          return {changes: {from: range.head - token.length, to: range.head + token.length},
                  range: EditorSelection.cursor(range.head - token.length),
                  userEvent: "delete.backward"}
      }
    }
    return {range: dont = range}
  })
  if (!dont) dispatch(state.update(changes, {scrollIntoView: true}))
  return !dont
}

/// Close-brackets related key bindings. Binds Backspace to
/// [`deleteBracketPair`](#closebrackets.deleteBracketPair).
export const closeBracketsKeymap: readonly KeyBinding[] = [
  {key: "Backspace", run: deleteBracketPair}
]

/// Implements the extension's behavior on text insertion. If the
/// given string counts as a bracket in the language around the
/// selection, and replacing the selection with it requires custom
/// behavior (inserting a closing version or skipping past a
/// previously-closed bracket), this function returns a transaction
/// representing that custom behavior. (You only need this if you want
/// to programmatically insert brackets—the
/// [`closeBrackets`](#closebrackets.closeBrackets) extension will
/// take care of running this for user input.)
export function insertBracket(state: EditorState, bracket: string): Transaction | null {
  let conf = config(state, state.selection.main.head)
  let tokens = conf.brackets || defaults.brackets
  for (let tok of tokens) {
    let closed = closing(codePointAt(tok, 0))
    if (bracket == tok)
      return closed == tok ? handleSame(state, tok, tokens.indexOf(tok + tok + tok) > -1) 
        : handleOpen(state, tok, closed, conf.before || defaults.before)
    if (bracket == closed && closedBracketAt(state, state.selection.main.from))
      return handleClose(state, tok, closed)
  }
  return null
}

function closedBracketAt(state: EditorState, pos: number) {
  let found = false
  state.field(bracketState).between(0, state.doc.length, from => {
    if (from == pos) found = true
  })
  return found
}

function nextChar(doc: Text, pos: number) {
  let next = doc.sliceString(pos, pos + 2)
  return next.slice(0, codePointSize(codePointAt(next, 0)))
}

function prevChar(doc: Text, pos: number) {
  let prev = doc.sliceString(pos - 2, pos)
  return codePointSize(codePointAt(prev, 0)) == prev.length ? prev : prev.slice(1)
}

function handleOpen(state: EditorState, open: string, close: string, closeBefore: string) {
  let dont = null, changes = state.changeByRange(range => {
    if (!range.empty)
      return {changes: [{insert: open, from: range.from}, {insert: close, from: range.to}],
              effects: closeBracketEffect.of(range.to + open.length),
              range: EditorSelection.range(range.anchor + open.length, range.head + open.length)}
    let next = nextChar(state.doc, range.head)
    if (!next || /\s/.test(next) || closeBefore.indexOf(next) > -1)
      return {changes: {insert: open + close, from: range.head},
              effects: closeBracketEffect.of(range.head + open.length),
              range: EditorSelection.cursor(range.head + open.length)}
    return {range: dont = range}
  })
  return dont ? null : state.update(changes, {
    scrollIntoView: true,
    userEvent: "input.type"
  })
}

function handleClose(state: EditorState, _open: string, close: string) {
  let dont = null, moved = state.selection.ranges.map(range => {
    if (range.empty && nextChar(state.doc, range.head) == close) return EditorSelection.cursor(range.head + close.length)
    return dont = range
  })
  return dont ? null : state.update({
    selection: EditorSelection.create(moved, state.selection.mainIndex),
    scrollIntoView: true,
    effects: state.selection.ranges.map(({from}) => skipBracketEffect.of(from))
  })
}

// Handles cases where the open and close token are the same, and
// possibly triple quotes (as in `"""abc"""`-style quoting).
function handleSame(state: EditorState, token: string, allowTriple: boolean) {
  let dont = null, changes = state.changeByRange(range => {
    if (!range.empty)
      return {changes: [{insert: token, from: range.from}, {insert: token, from: range.to}],
              effects: closeBracketEffect.of(range.to + token.length),
              range: EditorSelection.range(range.anchor + token.length, range.head + token.length)}
    let pos = range.head, next = nextChar(state.doc, pos)
    if (next == token) {
      if (nodeStart(state, pos)) {
        return {changes: {insert: token + token, from: pos},
                effects: closeBracketEffect.of(pos + token.length),
                range: EditorSelection.cursor(pos + token.length)}
      } else if (closedBracketAt(state, pos)) {
        let isTriple = allowTriple && state.sliceDoc(pos, pos + token.length * 3) == token + token + token
        return {range: EditorSelection.cursor(pos + token.length * (isTriple ? 3 : 1)),
                effects: skipBracketEffect.of(pos)}
      }
    } else if (allowTriple && state.sliceDoc(pos - 2 * token.length, pos) == token + token &&
               nodeStart(state, pos - 2 * token.length)) {
      return {changes: {insert: token + token + token + token, from: pos},
              effects: closeBracketEffect.of(pos + token.length),
              range: EditorSelection.cursor(pos + token.length)}
    } else if (state.charCategorizer(pos)(next) != CharCategory.Word) {
      let prev = state.sliceDoc(pos - 1, pos)
      if (prev != token && state.charCategorizer(pos)(prev) != CharCategory.Word && !probablyInString(state, pos, token))
        return {changes: {insert: token + token, from: pos},
                effects: closeBracketEffect.of(pos + token.length),
                range: EditorSelection.cursor(pos + token.length)}
    }
    return {range: dont = range}
  })
  return dont ? null : state.update(changes, {
    scrollIntoView: true,
    userEvent: "input.type"
  })
}

function nodeStart(state: EditorState, pos: number) {
  let tree = syntaxTree(state).resolveInner(pos + 1)
  return tree.parent && tree.from == pos
}

function probablyInString(state: EditorState, pos: number, quoteToken: string) {
  let node = syntaxTree(state).resolveInner(pos, -1)
  for (let i = 0; i < 5; i++) {
    if (state.sliceDoc(node.from, node.from + quoteToken.length) == quoteToken) return true
    let parent = node.to == pos && node.parent
    if (!parent) break
    node = parent
  }
  return false
}
