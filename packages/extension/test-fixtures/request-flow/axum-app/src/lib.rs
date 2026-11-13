mod admin;
mod health;
mod store;

use admin::admin_routes;
use health::health_routes;

struct AppState;

async fn list_pets(State(_db): State<AppState>) -> String {
    let store = store::SqlStore;
    store::load_pets(&store).await
}

async fn create_pet(State(_db): State<AppState>) -> &'static str {
    "created"
}

async fn pet_by_id(State(_db): State<AppState>) -> &'static str {
    "one"
}

pub fn dynamic(path: &str) -> () {
    Router::new().route(path, get(health::health))
}

pub fn api() -> () {
    Router::new()
        .route("/pets", get(list_pets).post(create_pet))
        .route("/pets/{id}", get(pet_by_id))
        .nest("/admin", admin_routes())
        .merge(health_routes())
        .route("/hook", get(|State(_s): State<AppState>| async { "ok" }))
}

pub fn main() {
    let listener = ();
    let app = api();
    axum::serve(listener, app);
    let _dynamic = dynamic("/ignored");
}
