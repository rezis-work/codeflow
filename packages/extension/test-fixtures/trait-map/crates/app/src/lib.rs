use shapes::{Circle, Draw, Square};

pub struct Widget;

impl Draw for Widget {
    fn draw(&self) {}
}

pub fn paint(widget: &Widget, shape: &dyn Draw, boxed: Box<dyn Draw>) {
    widget.draw();
    shape.draw();
    boxed.draw();
    Draw::draw(widget);
    <Square as Draw>::draw(&Square);
    let _kept = Circle { radius: 1 };
}
