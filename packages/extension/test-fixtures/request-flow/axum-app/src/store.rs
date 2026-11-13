pub trait PetStore {
    fn rows(&self) -> Vec<i64>;
}

pub struct SqlStore;

impl PetStore for SqlStore {
    fn rows(&self) -> Vec<i64> {
        Vec::new()
    }
}

pub async fn load_pets(store: &dyn PetStore) -> String {
    let _rows = sqlx::query!("SELECT id FROM pets").fetch_all(&());
    let _dyn = store.rows();
    "ok".into()
}
