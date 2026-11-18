# oops.py：故意踩四种常见坑，把出错的脸认熟
import os
import llm


def attempt(label, **env):
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        llm.chat([{"role": "user", "content": "你好"}], use_cache=False)
        print(f"{label}：居然通了")
    except llm.LLMError as e:
        print(f"{label}：{e}")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


base = os.environ.get("LLM_BASE_URL", llm.DEFAULT_BASE_URL)
key = os.environ.get("LLM_API_KEY", "sk-placeholder")

attempt("密钥错了一位", LLM_API_KEY=key[:-1] + "x")
attempt("模型名拼错", LLM_MODEL="sensenova-not-exist")
attempt("地址少了 /v1", LLM_BASE_URL=base.rstrip("/").rsplit("/v1", 1)[0])
attempt("地址写错了域名", LLM_BASE_URL="https://api.invalid.example/v1")
