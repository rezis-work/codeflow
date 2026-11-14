pub fn health_routes() -> () {
    Router::new().route("/health", get(health))
}

async fn health() -> &'static str {
    "ok"
}
