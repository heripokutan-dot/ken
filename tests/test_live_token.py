import logging

from fastapi.testclient import TestClient

from server import MODEL_ID, create_app


class FakeTokenClient:
    def __init__(self, token=None, error=None):
        self.token = token
        self.error = error
        self.config = None

    class AuthTokens:
        def __init__(self, owner):
            self.owner = owner

        def create(self, *, config):
            self.owner.config = config
            if self.owner.error:
                raise self.owner.error
            return self.owner.token

    @property
    def auth_tokens(self):
        return self.AuthTokens(self)


def client_for(api_key="test-secret-key", token_client=None):
    return TestClient(create_app(api_key=api_key, token_client=token_client), base_url="http://localhost")


def test_missing_api_key_returns_service_unavailable_without_secret(caplog):
    app_client = client_for(api_key="", token_client=FakeTokenClient())
    with caplog.at_level(logging.ERROR):
        response = app_client.post(
            "/api/live-token",
            headers={"origin": "http://localhost"},
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Gemini API is not configured."}
    assert "test-secret-key" not in caplog.text


def test_success_returns_ephemeral_token_and_safe_metadata_only(caplog):
    fake = FakeTokenClient(token=type("Token", (), {"name": "short-lived-token"})())
    with caplog.at_level(logging.DEBUG):
        response = client_for(token_client=fake).post(
            "/api/live-token",
            headers={"origin": "http://localhost"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "token": "short-lived-token",
        "model": MODEL_ID,
        "websocket_url": "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
    }
    assert response.headers["cache-control"] == "no-store"
    assert "short-lived-token" not in caplog.text
    assert "test-secret-key" not in caplog.text
    assert fake.config["uses"] == 1
    assert fake.config["live_connect_constraints"]["model"] == MODEL_ID
    assert fake.config["live_connect_constraints"]["config"]["response_modalities"] == ["AUDIO"]


def test_sdk_exception_is_sanitized_and_does_not_log_secrets(caplog):
    fake = FakeTokenClient(error=RuntimeError("sensitive provider detail test-secret-key"))
    with caplog.at_level(logging.ERROR):
        response = client_for(token_client=fake).post(
            "/api/live-token",
            headers={"origin": "http://localhost"},
        )

    assert response.status_code == 502
    assert response.json() == {"detail": "Could not create a Gemini Live session token."}
    assert "test-secret-key" not in caplog.text
    assert "sensitive provider detail" not in caplog.text


def test_rejects_unexpected_host():
    response = client_for(token_client=FakeTokenClient()).post(
        "/api/live-token",
        headers={"host": "evil.example", "origin": "http://evil.example"},
    )
    assert response.status_code == 400


def test_rejects_cross_origin_token_request():
    response = client_for(token_client=FakeTokenClient()).post(
        "/api/live-token",
        headers={"origin": "http://evil.example"},
    )
    assert response.status_code == 403


def test_rejects_malformed_host_with_userinfo():
    response = client_for(token_client=FakeTokenClient()).get(
        "/", headers={"host": "attacker@localhost"}
    )
    assert response.status_code == 400


def test_rejects_origin_with_different_scheme():
    response = client_for(token_client=FakeTokenClient()).post(
        "/api/live-token", headers={"origin": "https://localhost"}
    )
    assert response.status_code == 403
