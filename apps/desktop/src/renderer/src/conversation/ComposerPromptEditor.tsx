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
