pub fn admin_routes() -> () {
    Router::new().route("/stats", get(stats))
}

async fn stats() -> &'static str {
    "stats"
}
