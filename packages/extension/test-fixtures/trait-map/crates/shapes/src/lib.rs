pub mod remote;

pub trait Draw {
    fn draw(&self);
    fn label(&self) -> &'static str {
        "shape"
    }
}

pub trait Shape: Draw {
    fn area(&self) -> i32;
}

pub trait Wrapper<T>: Draw {
    fn wrap(&self, value: T);
}

pub struct Circle {
    pub radius: i32,
}

pub struct Square;

#[derive(Debug, Clone)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Draw for Circle {
    fn draw(&self) {}
}

impl Shape for Circle {
    fn area(&self) -> i32 {
        self.radius
    }
}

impl Wrapper<i32> for Circle {
    fn wrap(&self, _value: i32) {}
}

impl Draw for Square {
    fn draw(&self) {}
    fn label(&self) -> &'static str {
        "square"
    }
}

impl<T: Draw> Draw for Vec<T> {
    fn draw(&self) {}
}

impl<T: Draw> Draw for T {
    fn draw(&self) {}
}

impl std::fmt::Display for Circle {
    fn fmt(&self, _f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Ok(())
    }
}

impl Circle {
    pub fn radius(&self) -> i32 {
        self.radius
    }
}

pub fn concrete(circle: &Circle) {
    circle.draw();
    circle.label();
}

pub fn dynamic(shape: &dyn Draw) {
    shape.draw();
}

pub fn boxed(shape: Box<dyn Draw>) {
    shape.draw();
}

pub fn shared(shape: std::sync::Arc<dyn Draw>) {
    shape.draw();
}

pub fn generic<T: Draw>(shape: T) {
    shape.draw();
}

pub fn generic_where<T>(shape: T)
where
    T: Draw,
{
    shape.draw();
}

pub fn opaque(shape: impl Draw) {
    shape.draw();
}

pub fn ufcs_concrete(circle: &Circle) {
    Draw::draw(circle);
    <Circle as Draw>::label(circle);
}

pub fn ufcs_generic<T: Draw>(shape: T) {
    Draw::draw(&shape);
    <T as Draw>::label(&shape);
}
