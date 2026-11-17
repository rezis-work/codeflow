from app.greet import greet as say
from . import greet as greet_mod
import app.handlers as handlers
from app.handlers import unused


class Base:
    def hello(self, name: str) -> str:
        return say(name)


class Greeter(Base):
    def via_self(self):
        return self.hello("a")


def run(obj):
    return obj.hello("a")


def dynamic(obj):
    return getattr(obj, "hello")("a")


def direct():
    return handlers.unused(1)


def alias_call():
    return greet_mod.format_name("a")


def imported_unused():
    return unused(1)
