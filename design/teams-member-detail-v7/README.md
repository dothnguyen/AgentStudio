# Member details v7 (sections with edit dialogs)

Design for the member details screen (Teams > team > member). Built on the Design canvas "Agent Studio Teams Redesign",
artboard "Member details v2 - sections with edit dialogs". This folder is the export the board tickets refer to.

| File | What it is |
| --- | --- |
| `overview.png` / `overview.html` | The page: header, notice, Agents, Role instructions, Live status, Member settings, Remove member |
| `edit-member.png` / `edit-member.html` | Dialog "Edit member settings": General + Role + Permissions in one modal |
| `edit-agents.png` / `edit-agents.html` | Dialog "Edit agent options": reorder, remove, add from the Agents catalog |
| `edit-instructions.png` / `edit-instructions.html` | Dialog "Edit <role> instructions": description + prompt, saved to the role |
| `member-detail-v7.dc.html` | The source artboard (Design Component format). All states are driven by its `openDialog` prop: `none`, `member`, `agents`, `instructions`. It needs the Design canvas runtime to run; the static `.html` files above are plain HTML and open in any browser |

The static `.html` files are rendered from the source with the default sample data, so look at the markup and inline
styles for exact colours, sizes, spacing and states. The page is dark; tokens in use: page `#111316`, card `#16191d`,
card border `#262a30`, text `#e7e9ec`, muted `#8d949e`, accent `#5b9cff`, success `#6fd38b`, warning `#f0b453`.
Fonts: Inter and JetBrains Mono. The sidebar is only context: it is the existing app sidebar, not part of this work.

Behaviour shown by the source (open it to see the handlers):

- Each section is read-only. Its button opens that section's dialog; Cancel/close discards the draft, Save writes it.
- Agents: the list and the per-agent **Switch** button stay on the page (the live agent); **Edit options** opens the dialog.
- Changing the role in Edit member settings reloads the Role instructions section for the new role after saving.
- The sample names, roles, agent options and prompt text are placeholders; use the real data.

## Captures

The screenshots in `captures/` are rendered from the real member details screen and its three dialogs with
the capture fixture:

| File | What it shows |
| --- | --- |
| `captures/overview.png` | The member details page |
| `captures/edit-member.png` | Edit member settings |
| `captures/edit-agents.png` | Edit agent options |
| `captures/edit-instructions.png` | Edit role instructions |

Regenerate them with `npm --prefix app run capture:member` (Windows or a desktop Linux session; needs the
Electron binary). The command also writes `captures/manifest.json` with the SHA-256 of each image, so the
capture test fails if an image is stale or partly regenerated. The capture app adds the existing team page
header and tabs above the member page, and it uses real fixture data, so those parts differ from the
standalone artboards.
