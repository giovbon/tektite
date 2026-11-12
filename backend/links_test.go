package main

import "testing"

func TestResolveNoteLinkKeepsColonsInTitles(t *testing.T) {
	notes := []indexedNote{
		{GraphNode: GraphNode{ID: 7, Title: "261112 19:42"}},
		{GraphNode: GraphNode{ID: 9, Title: "Meeting notes", Folder: "Journal"}},
	}
	byPath, byTitle := makeNoteLinkIndexes(notes)

	if id := resolveNoteLink(indexedNote{}, "261112 19:42", byPath, byTitle); id != 7 {
		t.Fatalf("title with a colon resolved to %d, want 7", id)
	}
	if id := resolveNoteLink(indexedNote{GraphNode: GraphNode{Title: "Other", Folder: "Journal"}},
		"Meeting notes", byPath, byTitle); id != 9 {
		t.Fatalf("relative title resolved to %d, want 9", id)
	}
	if id := resolveNoteLink(indexedNote{}, "https://example.com/261112", byPath, byTitle); id != 0 {
		t.Fatalf("external URL resolved to note %d, want 0", id)
	}
	if id := resolveNoteLink(indexedNote{}, "Journal/Meeting notes?view=1", byPath, byTitle); id != 9 {
		t.Fatalf("URL with query resolved to %d, want 9", id)
	}
}
