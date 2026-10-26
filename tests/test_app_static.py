from fastapi.testclient import TestClient

from server import create_app


def test_root_serves_japanese_voice_interface():
    response = TestClient(create_app(api_key="test-key"), base_url="http://localhost").get("/")
    assert response.status_code == 200
    assert "Gemini Live 音声会話" in response.text
    assert 'id="start-button"' in response.text


def test_static_stylesheet_is_served_from_same_origin():
    response = TestClient(create_app(api_key="test-key"), base_url="http://localhost").get("/static/styles.css")
    assert response.status_code == 200
    assert ".transcript-grid" in response.text
