import re

files = [
    r"e:\trash_projects\New folder\VDT\visual_data_transfer_implementation_plan.md",
    r"e:\trash_projects\New folder\VDT\fullstack_build_plan (1).md",
    r"e:\trash_projects\New folder\VDT\module_coding_plan.md"
]

def process_file(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # Generic
    content = content.replace("session_store.py", "transfer_state.py")
    content = content.replace("sessions/", "state/")

    # 1. visual_data_transfer_implementation_plan.md
    content = re.sub(r"\| \*\*Session\*\* \| One complete file transfer.*?\|\n", "", content)
    content = content.replace("[0:4]   session_id        (4 bytes) — identifies which file transfer this belongs to\n", "")
    content = content.replace("[4:8]   symbol_seed        (4 bytes) — receiver uses this to derive degree + block indices", "[0:4]   symbol_seed        (4 bytes) — receiver uses this to derive degree + block indices")
    content = content.replace("[8:10]  payload_length     (2 bytes)", "[4:6]  payload_length     (2 bytes)")
    content = content.replace("[10:X]  payload            (variable — the XORed block data)", "[6:X]  payload            (variable — the XORed block data)")
    content = content.replace("Total overhead is only ~14 bytes", "Total overhead is only ~10 bytes")
    content = content.replace("[session_id][filename]", "[filename]")

    # 2. fullstack_build_plan (1).md
    content = content.replace("POST /api/session (upload", "POST /api/upload (upload")
    content = content.replace("POST /api/session/{id}/symbol", "POST /api/symbol")
    content = content.replace("GET /api/session/{id}/download", "GET /api/download")
    content = content.replace("`POST /api/session` | Upload", "`POST /api/upload` | Upload")
    content = content.replace("{ session_id, k, file_size", "{ k, file_size")
    content = content.replace("`GET /api/session/:id/metadata`", "`GET /api/metadata`")
    content = content.replace("`POST /api/session/:id/symbol`", "`POST /api/symbol`")
    content = content.replace("`GET /api/session/:id/download`", "`GET /api/download`")
    content = content.replace("`POST /api/session` → get back `session_id` + metadata", "`POST /api/upload` → get back metadata")
    content = re.sub(r"5\. Display the `session_id` as a small on-screen code too.*?flashing frames\.\n", "", content)

    # 3. module_coding_plan.md
    content = content.replace("`session_id`, `symbol_seed`", "`symbol_seed`")
    content = content.replace("`POST /api/session` — upload", "`POST /api/upload` — upload")
    content = content.replace("`POST /api/session/{id}/symbol` — receiver", "`POST /api/symbol` — receiver")
    content = content.replace("`GET /api/session/{id}/download` — serves", "`GET /api/download` — serves")
    content = content.replace("An in-memory `dict` keyed by `session_id`, holding", "A single global object holding")
    
    # Write back
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
        print(f"Updated {filepath}")

for f in files:
    process_file(f)
