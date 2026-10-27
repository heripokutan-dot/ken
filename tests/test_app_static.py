from fastapi.testclient import TestClient

from server import create_app


def test_root_serves_japanese_voice_interface():
    response = TestClient(create_app(api_key="test-key"), base_url="http://localhost").get("/")
    assert response.status_code == 200
    assert "Gemini Live 音声会話" in response.text
    assert 'id="start-button"' in response.text
    assert 'type="module" src="/app.js"' in response.text
    assert 'href="/styles.css"' in response.text


def test_static_stylesheet_is_served_from_same_origin():
    response = TestClient(create_app(api_key="test-key"), base_url="http://localhost").get("/static/styles.css")
    assert response.status_code == 200
    assert ".transcript-grid" in response.text


def test_root_asset_app_js_is_served_for_index_references():
    response = TestClient(create_app(api_key="test-key"), base_url="http://localhost").get("/app.js")
    assert response.status_code == 200
    assert "initSignIn" in response.text


def test_root_asset_worklet_is_served_for_audio_pipeline():
    response = TestClient(create_app(api_key="test-key"), base_url="http://localhost").get("/pcm-worklet.js")
    assert response.status_code == 200


def test_frontend_files_outside_the_allowlist_are_not_served():
    client = TestClient(create_app(api_key="test-key"), base_url="http://localhost")
    assert client.get("/_redirects").status_code == 404
    assert client.get("/server.py").status_code == 404


def test_local_auth_config_reports_local_provider_without_secrets():
    response = TestClient(create_app(api_key="test-key"), base_url="http://localhost").get("/api/auth-config")
    assert response.status_code == 200
    assert response.json() == {"provider": "local"}
    assert response.headers["cache-control"] == "no-store"
