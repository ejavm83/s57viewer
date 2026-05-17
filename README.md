# S-57 Web Chart Viewer

대한민국 S-57 전자해도(ENC) 데이터를 웹 브라우저에서 조회하는 뷰어입니다.

## 요구 사항

- Python 3.10+
- GDAL (pyogrio 의존)
- 로컬 S-57 해도 데이터 경로 (`server.py`의 `S57_DIR`)

## 실행

```bash
pip install -r requirements.txt
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

브라우저에서 `http://localhost:8000` 을 엽니다.

## 상세 문서

[DOCUMENTATION.md](DOCUMENTATION.md) 참고.

> 교육·시연 목적이며, 실제 항해용으로 사용할 수 없습니다.
