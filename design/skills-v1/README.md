# Skills screen v1 (a screen to manage skills)

Design for a new top-level **Skills** screen, built on the Design canvas "Agent Studio Teams Redesign", artboard "Skills -
catalog and skill details". It follows the Roles screen design (`design/roles-catalog-v2/`): a table for the list, a page per
item, section cards with their own Edit button, and dialogs for editing. A skill is a folder `.agent-studio/skills/<id>/SKILL.md`
that roles load into their context when an assignment starts. Roles list the skills they use (`roles.json`). Today the app can
only pick skills for a role; this screen lets you see, create, edit and delete them. This folder is the export the board tickets
refer to. The sidebar gets a new item, **Skills**, after Roles.

| File | What it is |
| --- | --- |
| `list.png` / `list.html` | Skills list: header, notice row, search, table (skill, summary, used by roles, size). A skill that roles list but that has no file is a row marked Missing |
| `detail.png` / `detail.html` | Skill page: breadcrumb, header with usage pill and Delete skill, Content card with preview, Details card, Used by roles card |
| `detail-missing.png` / `.html` | Page for a missing skill: amber note, "Create this skill", and the choice between creating the file and removing the skill from the roles |
| `edit-content.png` / `.html` | Dialog "Edit <skill>": markdown editor with a counter against 32 KiB |
| `edit-roles.png` / `.html` | Dialog "Roles that use <skill>": checklist of roles |
| `new-skill.png` / `.html` | Dialog "New skill": id (folder name) and starter content |
| `delete-skill.png` / `.html` | Delete confirmation (only for a skill no role uses) |
| `skills-v1.dc.html` | The source artboard. States come from its props: `startView` (`list`, `detail`), `startSkill` (a skill id, `legacy-notes` is the missing one) and `openDialog` (`none`, `content`, `roles`, `new`, `delete`). It needs the Design canvas runtime to run; the static `.html` files are plain HTML and open in any browser |

The static files are rendered from the source with sample data, so use their markup and inline styles for exact colours, sizes
and spacing. Tokens: page `#111316`, card `#16191d`, card border `#262a30`, text `#e7e9ec`, muted `#8d949e`, accent `#5b9cff`,
success `#6fd38b`, warning `#f0b453`, danger border `#4a2c2c` / text `#f0a3a3`. Fonts: Inter, JetBrains Mono. The sidebar is the
existing app sidebar plus the new Skills item.

Rules the screen must respect (from the backend: `roles.py`, `rolecatalog.py`):
- skill id = folder name, matching `^[a-z0-9][a-z0-9._-]{0,63}$`; it cannot change after creation;
- one file per skill, `skills/<id>/SKILL.md`, at most 32 KiB (`LIMITS["skill"]`);
- a role's whole context (instructions plus skills) is at most 96 KiB (`LIMITS["total"]`); a skill that does not fit is skipped;
- saved changes apply to new assignments; running assignments keep what they started with.

Sample data (skill names and contents, roles, context sizes) are placeholders; use the real data. The "Context n KB of 96 KiB"
line in Used by roles is the role's instructions plus all its skills.
