import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
} from 'react'
import { cn } from '../lib/utils'
import type { ComposerEditorHandle } from './composer-editor-handle'
import type { ComposerCaretLine } from './composer-history'

function editorText(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent())
}

function setEditorText(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const root = $getRoot()
    root.clear()
    const paragraph = $createParagraphNode()
    paragraph.append($createTextNode(text))
    root.append(paragraph)
  })
}

function domSelectionOffset(root: HTMLElement | null): number | null {
  const selection = window.getSelection()
  if (!root || !selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

const LINE_TOP_TOLERANCE_PX = 2

function getDistinctLineTops(rects: DOMRect[]): number[] {
  const tops: number[] = []
  for (const rect of rects) {
    if (rect.height <= 0) continue
    if (tops.every((top) => Math.abs(top - rect.top) > LINE_TOP_TOLERANCE_PX)) {
      tops.push(rect.top)
    }
  }
  return tops.sort((a, b) => a - b)
}

/** Resolve the collapsed caret's VISUAL line from DOM range geometry (including soft wraps). */
function resolveDomCaretLine(root: HTMLElement, range: Range): ComposerCaretLine | null {
  const text = root.textContent ?? ''
  if (text.length === 0) return 'only'

  const contentRange = document.createRange()
  contentRange.selectNodeContents(root)
  const lineTops = getDistinctLineTops(Array.from(contentRange.getClientRects()))
  if (lineTops.length <= 1) return 'only'

  const caretRects = Array.from(range.getClientRects())
  const caretRect = caretRects[0] ?? range.getBoundingClientRect()
  if (caretRect.height > 0 || caretRect.top !== 0) {
    const closest = lineTops.reduce((best, top) =>
      Math.abs(top - caretRect.top) < Math.abs(best - caretRect.top) ? top : best,
    )
    if (Math.abs(closest - lineTops[0]) <= LINE_TOP_TOLERANCE_PX) return 'first'
    if (Math.abs(closest - lineTops[lineTops.length - 1]) <= LINE_TOP_TOLERANCE_PX) return 'last'
    return 'middle'
  }

  // Chromium normally gives collapsed ranges a caret rect. Its geometry can be empty at an
  // extreme boundary, where the text offset is an unambiguous fallback.
  const offset = domSelectionOffset(root)
  if (offset === 0) return 'first'
  if (offset === text.length) return 'last'
  return null
}

function EditorBridge({
  value,
  editorRef,
}: {
  value: string
  editorRef: React.Ref<ComposerEditorHandle>
}): null {
  const [editor] = useLexicalComposerContext()
  const lastExternalValueRef = useRef(value)

  useImperativeHandle(
    editorRef,
    () => ({
      getSelectionStart: () => domSelectionOffset(editor.getRootElement()),
      getSelection: () => {
        const root = editor.getRootElement()
        const selection = window.getSelection()
        if (!root || !selection || selection.rangeCount === 0) return null
        const range = selection.getRangeAt(0)
        if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
        return {
          collapsed: range.collapsed,
          caretLine: range.collapsed ? resolveDomCaretLine(root, range) : null,
        }
      },
      focus: () => editor.focus(),
      setSelectionRange(start) {
        editor.focus(() => {
          const selection = window.getSelection()
          const root = editor.getRootElement()
          const textNode = root?.firstChild?.firstChild ?? null
          if (!selection || !textNode) return
          const range = document.createRange()
          range.setStart(textNode, Math.min(start, textNode.textContent?.length ?? 0))
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
        })
      },
    }),
    [editor],
  )

  useEffect(() => {
    if (value === lastExternalValueRef.current) return
    if (editorText(editor) === value) {
      lastExternalValueRef.current = value
      return
    }
    setEditorText(editor, value)
    lastExternalValueRef.current = value
  }, [editor, value])

  return null
}

export interface ComposerPromptEditorProps {
  value: string
  placeholder: string
  disabled?: boolean
  className?: string
  onChange: (value: string, caret: number | null) => void
  onSelect: (value: string, caret: number | null) => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void
}

export const ComposerPromptEditor = forwardRef<ComposerEditorHandle, ComposerPromptEditorProps>(
  function ComposerPromptEditor(
    { value, placeholder, disabled = false, className, onChange, onSelect, onKeyDown, onPaste },
    ref,
  ): JSX.Element {
    const initialConfig = {
      namespace: 'ComposerPromptEditor',
      editable: !disabled,
      onError(error: Error) {
        throw error
      },
      editorState(editor: LexicalEditor) {
        setEditorText(editor, value)
      },
    }

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div className={cn('relative', disabled && 'pointer-events-none opacity-50')}>
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className={cn(
                  'min-h-[3rem] w-full resize-none bg-transparent p-0 text-[17px] leading-normal text-text outline-none',
                  'whitespace-pre-wrap break-words',
                  className,
                )}
                aria-label={placeholder}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onSelect={(event) => {
                  const text = event.currentTarget.textContent ?? ''
                  onSelect(text, domSelectionOffset(event.currentTarget))
                }}
              />
            }
            placeholder={
              <div className="pointer-events-none absolute top-0 left-0 text-[17px] leading-normal text-placeholder">
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <OnChangePlugin
            onChange={(editorState, editor) => {
              let text = ''
              editorState.read(() => {
                text = $getRoot().getTextContent()
              })
              lastValueOnChange(editor, text, onChange)
            }}
          />
          <EditorBridge value={value} editorRef={ref} />
        </div>
      </LexicalComposer>
    )
  },
)

function lastValueOnChange(
  editor: LexicalEditor,
  text: string,
  onChange: (value: string, caret: number | null) => void,
): void {
  onChange(text, domSelectionOffset(editor.getRootElement()))
}
