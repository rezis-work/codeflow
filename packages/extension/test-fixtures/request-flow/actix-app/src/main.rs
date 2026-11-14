fn load() -> &'static str {
    let _rows = pets::table.load(&mut ());
    "loaded"
}

#[get("/pets")]
async fn list_pets() -> &'static str {
    load()
}

#[post("/pets")]
async fn create_pet() -> &'static str {
    "created"
}

#[route("/pets/{id}", method = "GET", method = "DELETE")]
async fn pet() -> &'static str {
    "pet"
}

async fn health() -> &'static str {
    "ok"
}

async fn search() -> &'static str {
    "search"
}

fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api")
            .service(list_pets)
            .service(create_pet)
            .route("/health", web::get().to(health))
            .service(
                web::resource("/search")
                    .route(web::get().to(search))
                    .route(web::post().to(search)),
            )
            .route("/hook", web::get().to(|_req| "ok")),
    );
    let path = std::env::var("ROUTE").unwrap();
    cfg.route(path, web::get().to(health));
}

#[actix_web::main]
async fn main() -> () {
    App::new().configure(config);
}
