package main

import (
	"log"
	"net/http"
	"strconv"
	"strings"
)

// TableNote is the row shape consumed by the Tabulator view. Properties holds
// every top-level key found in the note frontmatter, and Attachments is
// embedded so the frontend can build the tree without extra requests.
type TableNote struct {
	ID          int64          `json:"id"`
	Title       string         `json:"title"`
	Folder      string         `json:"folder"`
	Tags        []string       `json:"tags,omitempty"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
	Properties  map[string]any `json:"properties"`
	Attachments []Attachment   `json:"attachments"`
}

// ListTableNotes returns every note matching the folder/tag filters with its
// parsed frontmatter and attachments. The table view is intentionally not
// paginated: the frontend filters and pages the data locally.
func (a *App) ListTableNotes(folder, tag string) ([]TableNote, error) {
	rows, err := a.db.Query(`SELECT rowid, title, folder, COALESCE(tags, ''),
		COALESCE(content, ''), created_at, updated_at
		FROM notes
		WHERE (folder = ? OR ? = '')
		AND (? = '' OR instr(',' || lower(COALESCE(tags, '')) || ',', ',' || lower(?) || ',') > 0)
		ORDER BY updated_at DESC, rowid DESC`,
		folder, folder, tag, tag)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]TableNote, 0)
	noteIDs := make(map[int64]int)
	for rows.Next() {
		var item TableNote
		var tags string
		var content string
		if err := rows.Scan(&item.ID, &item.Title, &item.Folder, &tags, &content,
			&item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.Tags = splitTags(tags)
		item.Properties = frontmatterProperties(content)
		if len(item.Tags) > 0 {
			item.Properties["tags"] = item.Tags
		}
		item.Attachments = make([]Attachment, 0)
		noteIDs[item.ID] = len(items)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return items, nil
	}

	attachmentRows, err := a.db.Query(`SELECT id, note_id, filename, media_type, size, created_at
		FROM attachments ORDER BY note_id, created_at, id`)
	if err != nil {
		return nil, err
	}
	defer attachmentRows.Close()
	for attachmentRows.Next() {
		var item Attachment
		if err := attachmentRows.Scan(&item.ID, &item.NoteID, &item.Filename,
			&item.MediaType, &item.Size, &item.CreatedAt); err != nil {
			return nil, err
		}
		position, ok := noteIDs[item.NoteID]
		if !ok {
			continue
		}
		item.URL = attachmentURL(item.NoteID, item.ID)
		items[position].Attachments = append(items[position].Attachments, item)
	}
	if err := attachmentRows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

// frontmatterProperties parses the top-level YAML keys between the leading
// "---" markers. It supports scalars, quoted strings, inline and block lists,
// nested mappings and block scalars, which covers the metadata used by notes.
func frontmatterProperties(content string) map[string]any {
	properties := make(map[string]any)
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return properties
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		marker := strings.TrimSpace(lines[i])
		if marker == "---" || marker == "..." {
			end = i
			break
		}
	}
	if end < 0 {
		return properties
	}
	index := 1
	for index < end {
		line := lines[index]
		if isBlankOrComment(line) || lineIndent(line) > 0 || strings.HasPrefix(strings.TrimSpace(line), "-") {
			index++
			continue
		}
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found {
			index++
			continue
		}
		key = strings.Trim(strings.TrimSpace(key), `"'`)
		if key == "" {
			index++
			continue
		}
		value = strings.TrimSpace(value)
		index++
		if isBlockScalarHeader(value) {
			properties[key] = parseBlockScalar(lines, &index, end, 0, strings.HasPrefix(value, ">"))
			continue
		}
		if value == "" {
			next := nextContentLine(lines, index, end)
			if next >= 0 && lineIndent(lines[next]) > 0 {
				childIndent := lineIndent(lines[next])
				if strings.HasPrefix(strings.TrimSpace(lines[next]), "-") {
					properties[key] = parseYAMLSequence(lines, &index, end, childIndent)
				} else {
					properties[key] = parseYAMLMapping(lines, &index, end, childIndent)
				}
				continue
			}
			properties[key] = nil
			continue
		}
		properties[key] = parseYAMLScalar(value)
	}
	return properties
}

func parseYAMLMapping(lines []string, index *int, end, indent int) map[string]any {
	result := make(map[string]any)
	for *index < end {
		line := lines[*index]
		if isBlankOrComment(line) {
			*index++
			continue
		}
		current := lineIndent(line)
		if current < indent {
			break
		}
		if current > indent || strings.HasPrefix(strings.TrimSpace(line), "-") {
			*index++
			continue
		}
		key, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found {
			*index++
			continue
		}
		key = strings.Trim(strings.TrimSpace(key), `"'`)
		if key == "" {
			*index++
			continue
		}
		value = strings.TrimSpace(value)
		*index++
		if isBlockScalarHeader(value) {
			result[key] = parseBlockScalar(lines, index, end, indent, strings.HasPrefix(value, ">"))
			continue
		}
		if value == "" {
			next := nextContentLine(lines, *index, end)
			if next >= 0 && lineIndent(lines[next]) > indent {
				childIndent := lineIndent(lines[next])
				if strings.HasPrefix(strings.TrimSpace(lines[next]), "-") {
					result[key] = parseYAMLSequence(lines, index, end, childIndent)
				} else {
					result[key] = parseYAMLMapping(lines, index, end, childIndent)
				}
				continue
			}
			result[key] = nil
			continue
		}
		result[key] = parseYAMLScalar(value)
	}
	return result
}

func parseYAMLSequence(lines []string, index *int, end, indent int) []any {
	items := make([]any, 0)
	for *index < end {
		line := lines[*index]
		if isBlankOrComment(line) {
			*index++
			continue
		}
		if lineIndent(line) != indent || !strings.HasPrefix(strings.TrimSpace(line), "-") {
			break
		}
		value := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-"))
		*index++
		if value == "" {
			next := nextContentLine(lines, *index, end)
			if next >= 0 && lineIndent(lines[next]) > indent {
				childIndent := lineIndent(lines[next])
				if strings.HasPrefix(strings.TrimSpace(lines[next]), "-") {
					items = append(items, parseYAMLSequence(lines, index, end, childIndent))
				} else {
					items = append(items, parseYAMLMapping(lines, index, end, childIndent))
				}
				continue
			}
			items = append(items, nil)
			continue
		}
		items = append(items, parseYAMLScalar(value))
	}
	return items
}

func parseBlockScalar(lines []string, index *int, end, parentIndent int, folded bool) string {
	collected := make([]string, 0)
	minIndent := -1
	for *index < end {
		line := lines[*index]
		if strings.TrimSpace(line) == "" {
			collected = append(collected, "")
			*index++
			continue
		}
		if lineIndent(line) <= parentIndent {
			break
		}
		if indent := lineIndent(line); minIndent < 0 || indent < minIndent {
			minIndent = indent
		}
		collected = append(collected, line)
		*index++
	}
	for len(collected) > 0 && strings.TrimSpace(collected[len(collected)-1]) == "" {
		collected = collected[:len(collected)-1]
	}
	dedented := make([]string, 0, len(collected))
	for _, line := range collected {
		if strings.TrimSpace(line) == "" {
			dedented = append(dedented, "")
			continue
		}
		cut := minIndent
		if cut < 0 {
			cut = 0
		}
		if cut > len(line) {
			cut = len(line)
		}
		dedented = append(dedented, line[cut:])
	}
	if folded {
		return strings.Join(dedented, " ")
	}
	return strings.Join(dedented, "\n")
}

func parseYAMLScalar(raw string) any {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		inner := strings.TrimSpace(value[1 : len(value)-1])
		if inner == "" {
			return []any{}
		}
		parts := splitYAMLInline(inner)
		items := make([]any, 0, len(parts))
		for _, part := range parts {
			items = append(items, parseYAMLScalar(part))
		}
		return items
	}
	if strings.HasPrefix(value, "{") && strings.HasSuffix(value, "}") {
		result := make(map[string]any)
		for _, part := range splitYAMLInline(strings.TrimSpace(value[1 : len(value)-1])) {
			key, item, found := strings.Cut(part, ":")
			if !found {
				continue
			}
			result[strings.Trim(strings.TrimSpace(key), `"'`)] = parseYAMLScalar(item)
		}
		return result
	}
	if len(value) >= 2 {
		switch {
		case value[0] == '"' && value[len(value)-1] == '"':
			if unquoted, err := strconv.Unquote(value); err == nil {
				return unquoted
			}
			return value[1 : len(value)-1]
		case value[0] == '\'' && value[len(value)-1] == '\'':
			return strings.ReplaceAll(value[1:len(value)-1], "''", "'")
		}
	}
	if comment := strings.Index(value, " #"); comment > 0 {
		value = strings.TrimSpace(value[:comment])
	}
	switch strings.ToLower(value) {
	case "true":
		return true
	case "false":
		return false
	case "null", "~":
		return nil
	}
	if integer, err := strconv.ParseInt(value, 10, 64); err == nil {
		return integer
	}
	if number, err := strconv.ParseFloat(value, 64); err == nil {
		return number
	}
	return value
}

func splitYAMLInline(value string) []string {
	parts := make([]string, 0)
	var current strings.Builder
	var quote rune
	depth := 0
	for _, char := range value {
		switch {
		case quote != 0:
			current.WriteRune(char)
			if char == quote {
				quote = 0
			}
		case char == '"' || char == '\'':
			quote = char
			current.WriteRune(char)
		case char == '[' || char == '{':
			depth++
			current.WriteRune(char)
		case char == ']' || char == '}':
			depth--
			current.WriteRune(char)
		case char == ',' && depth == 0:
			parts = append(parts, strings.TrimSpace(current.String()))
			current.Reset()
		default:
			current.WriteRune(char)
		}
	}
	if strings.TrimSpace(current.String()) != "" {
		parts = append(parts, strings.TrimSpace(current.String()))
	}
	return parts
}

func isBlockScalarHeader(value string) bool {
	switch strings.TrimSpace(value) {
	case "|", ">", "|-", ">-", "|+", ">+":
		return true
	default:
		return false
	}
}

func nextContentLine(lines []string, start, end int) int {
	for i := start; i < end; i++ {
		if !isBlankOrComment(lines[i]) {
			return i
		}
	}
	return -1
}

func isBlankOrComment(line string) bool {
	trimmed := strings.TrimSpace(line)
	return trimmed == "" || strings.HasPrefix(trimmed, "#")
}

func lineIndent(line string) int {
	indent := 0
	for _, char := range line {
		switch char {
		case ' ':
			indent++
		case '\t':
			indent += 2
		default:
			return indent
		}
	}
	return indent
}

func (a *App) handleTable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	items, err := a.ListTableNotes(r.URL.Query().Get("folder"), r.URL.Query().Get("tag"))
	if err != nil {
		log.Printf("list table notes: %v", err)
		http.Error(w, "failed to list table notes", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
