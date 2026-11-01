# Roles screen v2 (table + role page with edit dialogs)

Redesign of the Roles screen, built on the Design canvas "Agent Studio Teams Redesign", artboard "Roles - catalog and role
details". It follows the Teams screen and the Member details v7 design (`design/teams-member-detail-v7/`): a table for
the list, a page per item, section cards with their own Edit button, and dialogs for editing. This folder is the export
the board tickets refer to.

| File | What it is |
| --- | --- |
| `list.png` / `list.html` | Roles list: header, notice row, search, table (role, description, skills, used by) |
| `detail.png` / `detail.html` | Role page: breadcrumb, header with Delete role, Overview, Shared instructions, Skills, Used by |
| `edit-overview.png` / `.html` | Dialog "Edit overview": name, locked role id, description |
| `edit-instructions.png` / `.html` | Dialog "Edit <role> instructions": prompt textarea with byte counter against 16 KiB |
| `edit-skills.png` / `.html` | Dialog "Edit skills": checklist of available skills |
| `new-role.png` / `.html` | Dialog "New role": name, role id (derived from the name), optional description |
| `delete-role.png` / `.html` | Delete confirmation (only for a role no member uses) |
| `roles-v2.dc.html` | The source artboard. All states are driven by its `startView` (`list`, `detail`) and `openDialog` (`none`, `general`, `instructions`, `skills`, `new`, `delete`) props. It needs the Design canvas runtime to run; the static `.html` files are plain HTML and open in any browser |

The static files are rendered from the source with sample data, so use their markup and inline styles for exact colours,
sizes and spacing. Tokens: page `#111316`, card `#16191d`, card border `#262a30`, text `#e7e9ec`, muted `#8d949e`, accent
`#5b9cff`, success `#6fd38b`, warning `#f0b453`, danger border `#4a2c2c` / text `#f0a3a3`. Fonts: Inter, JetBrains Mono.
The sidebar is the existing app sidebar, not part of this work.

## Captures

The real Roles screen is captured against this folder with the app's fixture data:

```powershell
npm --prefix app run capture:roles
```

The command builds the app, opens a hidden 1440x1240 window at device scale factor 1 and writes
`captures/list.png`, `captures/detail.png`, `captures/edit-overview.png`, `captures/edit-instructions.png`,
`captures/edit-skills.png`, `captures/new-role.png` and `captures/delete-role.png`, plus
`captures/manifest.json` with the image sizes and checksums. It needs the Electron binary and is an operator
check, not part of `npm test`.

The captures use the real catalog data and the app's own sidebar, so they differ from the static files in
these ways:

- The Used by row shows the saved/live state the app really has (`Saved and Live · available`), not the
  shortened design label.
- The `delete-role` capture opens an unused role (ProductOwner), because the app only offers Delete when no
  member references the role; the design background shows a referenced role with Delete disabled.
- The app adds the "Warnings and problems" card when a role has warnings or assignment-source problems;
  the design does not show that card.
- The Used by card ends with the app's "Roles do not grant permissions…" disclaimer.
- A dialog opened from an unchanged draft has its Save button disabled (the design shows the enabled style);
  the button becomes enabled as soon as the draft differs.
- The prompt preview and byte count come from the real instruction file, and a long prompt scrolls inside
  its editor.

Behaviour shown by the source:

- A table row opens the role page; the breadcrumb "Roles" returns to the list. Creating a role opens its page; deleting one returns to the list.
- Each card on the role page is read-only; its Edit button opens that card's dialog. Cancel or close discards the draft.
- Delete role is disabled, with the reason shown under the header, while any member uses the role.
- The sample roles, descriptions, prompts, skills and members are placeholders; use the real catalog data. The amber "missing" skill chip shows how a skill that no longer exists is flagged.
- Not designed here: the role's warnings and problems (they exist in the catalog). Keep showing them in the current way, as a list inside the relevant card, until a design exists.
