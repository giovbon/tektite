package main

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestFrontmatterProperties(t *testing.T) {
	content := `---
title: ignored
status: ativo
priority: 2
draft: false
tags: [projeto, "referência"]
owner:
  name: Ana
  team: Produto
steps:
  - primeiro
  - segundo
notes: |
  linha um
  linha dois
---

Corpo da nota.`
	properties := frontmatterProperties(content)

	if got := properties["status"]; got != "ativo" {
		t.Fatalf("status = %#v", got)
	}
	if got := properties["priority"]; got != int64(2) {
		t.Fatalf("priority = %#v", got)
	}
	if got := properties["draft"]; got != false {
		t.Fatalf("draft = %#v", got)
	}
	tags, ok := properties["tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "projeto" || tags[1] != "referência" {
		t.Fatalf("tags = %#v", properties["tags"])
	}
	owner, ok := properties["owner"].(map[string]any)
	if !ok || owner["name"] != "Ana" || owner["team"] != "Produto" {
		t.Fatalf("owner = %#v", properties["owner"])
	}
	steps, ok := properties["steps"].([]any)
	if !ok || len(steps) != 2 || steps[1] != "segundo" {
		t.Fatalf("steps = %#v", properties["steps"])
	}
	if got := properties["notes"]; got != "linha um\nlinha dois" {
		t.Fatalf("notes = %#v", got)
	}
	if properties["title"] != "ignored" {
		t.Fatalf("title property = %#v", properties["title"])
	}
}

func TestTableHandlerReturnsPropertiesAndAttachments(t *testing.T) {
	app := newTestApp(t)
	handler := app.Handler(filepath.Join("..", "web", "frontend"))

	noteID, err := app.CreateNote(Note{
		Title:  "Plano",
		Folder: "Projetos",
		Content: `---
status: ativo
prioridade: alta
tags: [projeto, sqlite]
---
Corpo`,
	})
	if err != nil {
		t.Fatal(err)
	}
	attachment, err := app.SaveAttachment(noteID, strings.NewReader("conteúdo"), "diagrama.png")
	if err != nil {
		t.Fatal(err)
	}

	response := performJSONRequest(t, handler, http.MethodGet, "/api/table?folder=Projetos", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	payload := decodeResponse[struct {
		Items []TableNote `json:"items"`
	}](t, response)
	if len(payload.Items) != 1 {
		t.Fatalf("items = %#v", payload.Items)
	}
	item := payload.Items[0]
	if item.Title != "Plano" || item.Folder != "Projetos" {
		t.Fatalf("unexpected note: %#v", item)
	}
	if item.Properties["status"] != "ativo" || item.Properties["prioridade"] != "alta" {
		t.Fatalf("properties = %#v", item.Properties)
	}
	if len(item.Attachments) != 1 || item.Attachments[0].ID != attachment.ID {
		t.Fatalf("attachments = %#v", item.Attachments)
	}
	if item.Attachments[0].URL == "" {
		t.Fatalf("attachment URL is empty")
	}
}
