import { useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  file,
  LoadIcon,
  save,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";

import { listRepositoryNotes } from "../data/repositoryNotes";

import "./RepositoryNotesDialog.scss";

export const RepositoryNotesDialog = (props: {
  mode: "save" | "open";
  initialName?: string | null;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
  onOpen: (name: string) => Promise<void>;
}) => {
  const [name, setName] = useState(props.initialName || "note");
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.mode === "open") {
      listRepositoryNotes()
        .then(setNotes)
        .catch((err) => setError(err.message));
    } else {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [props.mode]);

  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery
      ? notes.filter((note) => note.toLowerCase().includes(normalizedQuery))
      : notes;
  }, [notes, query]);

  const saveNote = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a file name");
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      await props.onSave(trimmedName);
      props.onClose();
    } catch (err: any) {
      setError(err.message || "Unable to save repository note");
    } finally {
      setIsLoading(false);
    }
  };

  const openNote = async (note: string) => {
    setError(null);
    setIsLoading(true);
    try {
      await props.onOpen(note);
      props.onClose();
    } catch (err: any) {
      setError(err.message || "Unable to open repository note");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog
      className="RepositoryNotesDialog"
      title={
        props.mode === "save" ? "Save to repository" : "Open repository note"
      }
      onCloseRequest={props.onClose}
      size="small"
    >
      {props.mode === "save" ? (
        <form
          className="RepositoryNotesDialog__save"
          onSubmit={(event) => {
            event.preventDefault();
            void saveNote();
          }}
        >
          <div className="RepositoryNotesDialog__location">
            <span className="RepositoryNotesDialog__locationIcon">
              {LoadIcon}
            </span>
            <span>notes</span>
            <span className="RepositoryNotesDialog__separator">/</span>
            <span className="RepositoryNotesDialog__muted">new note</span>
          </div>
          <TextField
            ref={nameInputRef}
            label="File name"
            value={name}
            onChange={setName}
            placeholder="note"
            fullWidth
          />
          <div className="RepositoryNotesDialog__extension">
            <span>File type</span>
            <code>.excalidraw</code>
          </div>
          {error && (
            <p className="RepositoryNotesDialog__error" role="alert">
              {error}
            </p>
          )}
          <div className="RepositoryNotesDialog__actions">
            <FilledButton
              label="Cancel"
              variant="outlined"
              color="muted"
              onClick={props.onClose}
            />
            <FilledButton
              label="Save note"
              icon={save}
              onClick={() => void saveNote()}
              status={isLoading ? "loading" : null}
              disabled={!name.trim()}
            />
          </div>
        </form>
      ) : (
        <div className="RepositoryNotesDialog__open">
          <div className="RepositoryNotesDialog__location">
            <span className="RepositoryNotesDialog__locationIcon">
              {LoadIcon}
            </span>
            <span>notes</span>
            <span className="RepositoryNotesDialog__separator">/</span>
            <span className="RepositoryNotesDialog__muted">
              repository files
            </span>
          </div>
          <TextField
            icon={searchIcon}
            value={query}
            onChange={setQuery}
            placeholder="Search notes"
            fullWidth
            type="search"
          />
          {error && (
            <p className="RepositoryNotesDialog__error" role="alert">
              {error}
            </p>
          )}
          <div
            className="RepositoryNotesDialog__list"
            role="listbox"
            aria-label="Repository notes"
          >
            {filteredNotes.map((note) => (
              <button
                key={note}
                className="RepositoryNotesDialog__note"
                type="button"
                onClick={() => void openNote(note)}
                disabled={isLoading}
              >
                <span className="RepositoryNotesDialog__noteIcon">{file}</span>
                <span className="RepositoryNotesDialog__noteName">{note}</span>
                <span className="RepositoryNotesDialog__noteArrow">
                  &#8594;
                </span>
              </button>
            ))}
            {!error && filteredNotes.length === 0 && (
              <div className="RepositoryNotesDialog__empty">
                <span className="RepositoryNotesDialog__emptyIcon">{file}</span>
                <strong>
                  {notes.length
                    ? "No matching notes"
                    : "No repository notes yet"}
                </strong>
                <span>
                  {notes.length
                    ? "Try a different search."
                    : "Save your current canvas to create one."}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
};
