# raw.py：不用任何封装，亲手向 Token Plan 寄出第一封信，把请求和完整回执原样印出来
import json
import os
import urllib.request

BASE_URL = os.environ.get("LLM_BASE_URL", "https://token.sensetime.com/api/v1").rstrip("/")
API_KEY = os.environ["LLM_API_KEY"]
MODEL = os.environ.get("LLM_MODEL", "sensenova-6.8-flash")

body = {
    "model": MODEL,
    "messages": [{"role": "user", "content": "用一句话说说，把《上册》笔记装进个人知识库有什么用？"}],
}
print("寄出去的：")
print(json.dumps(body, ensure_ascii=False, indent=2))

req = urllib.request.Request(
    BASE_URL + "/chat/completions",
    data=json.dumps(body).encode("utf-8"),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
)
with urllib.request.urlopen(req, timeout=60) as resp:
    data = json.loads(resp.read().decode("utf-8"))

if "id" in data:
    data["id"] = data["id"][:14] + "…"
print("\n收回来的：")
print(json.dumps(data, ensure_ascii=False, indent=2))
