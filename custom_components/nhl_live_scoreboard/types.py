"""Documented card-facing data shapes; missing ESPN fields remain optional."""

from __future__ import annotations

from typing import Any, TypedDict


class TeamMetadata(TypedDict, total=False):
    id: str
    abbreviation: str
    name: str
    short_name: str
    logo: str
    record_summary: str


class PeriodContext(TypedDict, total=False):
    period: int
    display_period: str
    display_clock: str
    period_prefix: str
    label: str
    is_intermission: bool
    is_shootout: bool
    is_end_period: bool
    is_overtime: bool


class Situation(TypedDict, total=False):
    away_shots_on_goal: int | None
    home_shots_on_goal: int | None
    strength: str
    power_play_team_id: str
    power_play: bool | None
    empty_net: bool | None
    away_empty_net: bool | None
    home_empty_net: bool | None


class GoalieStats(TypedDict, total=False):
    saves: str
    shots_against: str
    goals_against: str
    save_percentage: str
    wins: str
    losses: str
    overtime_losses: str
    goals_against_average: str
    shutouts: str
    season: str


class Goalie(TypedDict, total=False):
    id: str
    display_name: str
    short_name: str
    headshot: str
    team_id: str
    game_stats: GoalieStats
    season_stats: GoalieStats
    source: str


class Goalies(TypedDict, total=False):
    away: Goalie
    home: Goalie


class RecentPlay(TypedDict, total=False):
    id: str
    text: str
    away_score: int | None
    home_score: int | None
    wallclock_ts: float | None
    scoring_play: bool
    score_value: int
    play_type: str
    abbreviation: str
    period: int
    clock: str
    team_id: str
    is_penalty: bool
    is_shootout: bool
    is_shot: bool
    coordinate: dict[str, float]
    shot_type: str
    strength: str


class ScoringPlay(TypedDict, total=False):
    id: str
    text: str
    period_type: str
    period_number: int
    period: int
    clock: str
    away_score: int | None
    home_score: int | None
    score_value: int
    team_id: str
    play_type: str
    abbreviation: str
    strength: str
    is_shootout: bool


class GamePeriod(TypedDict, total=False):
    id: str
    number: int
    label: str
    description: str
    play_count: int
    goals: int
    away_goals: int | None
    home_goals: int | None
    is_current: bool
    is_shootout: bool


class TeamStatsRow(TypedDict, total=False):
    id: str
    name: str
    short_name: str
    position: str
    jersey: str
    headshot: str
    stats: list[str]


class TeamStatsCategory(TypedDict, total=False):
    name: str
    label: str
    columns: list[str]
    keys: list[str]
    descriptions: list[str]
    totals: list[str]
    rows: list[TeamStatsRow]


class TeamStatsSide(TypedDict, total=False):
    team_id: str
    abbreviation: str
    name: str
    short_name: str
    logo: str
    source: str
    categories: list[TeamStatsCategory]


class TeamStats(TypedDict, total=False):
    away: TeamStatsSide
    home: TeamStatsSide


class LeaderEntry(TypedDict, total=False):
    category: str
    value: str
    name: str
    id: str
    headshot: str


class Leaders(TypedDict, total=False):
    away: list[LeaderEntry]
    home: list[LeaderEntry]


class WinProbability(TypedDict, total=False):
    home: float
    away: float
    tie: float


class StandingsEntry(TypedDict, total=False):
    team_id: str
    team_name: str
    team_short_name: str
    wins: str
    losses: str
    overtime_losses: str
    points: str


class Standings(TypedDict, total=False):
    division_name: str
    entries: list[StandingsEntry]


class PlayerCardBio(TypedDict, total=False):
    name: str
    team: str
    position: str
    height: str
    weight: str
    age: str
    jersey: str
    headshot: str
    draft: str
    college: str
    experience: str
    hometown: str


class PlayerCareerSeason(TypedDict, total=False):
    year: str
    team: str
    stats: list[str]


class PlayerCareerTable(TypedDict, total=False):
    kind: str
    label: str
    columns: list[str]
    keys: list[str]
    seasons: list[PlayerCareerSeason]
    totals: list[str]


class PlayerCard(TypedDict, total=False):
    id: str
    bio: PlayerCardBio
    career: PlayerCareerTable
    glossary: dict[str, str]


Competition = dict[str, Any]
