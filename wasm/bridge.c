// kingbi ↔ box3d bridge — the minimal chunk-simulation surface.
// Single-threaded WASM build (in-app browsers: no SharedArrayBuffer).
// Bodies live in a fixed slot pool so JS and C share slot indices; states
// (position + quaternion per slot) export through one flat buffer.
#include "box3d/box3d.h"

#include <stdint.h>

#define BX_MAX_BODIES 3072
#define BX_STATE_FLOATS 8 // x y z qx qy qz qw + 1 spare

static b3WorldId g_world = {0};
static b3BodyId g_bodies[BX_MAX_BODIES];
static uint8_t g_alive[BX_MAX_BODIES];
static float g_states[BX_MAX_BODIES * BX_STATE_FLOATS];
static int g_aliveCount = 0;

void bx_init(float gravityY, float groundY, float halfExtent)
{
	g_world = ( b3WorldId ){ 0, 0 };
	for (int i = 0; i < BX_MAX_BODIES; ++i)
	{
		g_bodies[i] = ( b3BodyId ){ 0, 0, 0 };
		g_alive[i] = 0;
	}
	g_aliveCount = 0;

	b3WorldDef worldDef = b3DefaultWorldDef();
	worldDef.gravity = ( b3Vec3 ){ 0.0f, gravityY, 0.0f };
	g_world = b3CreateWorld( &worldDef );

	// One big static slab under the battlefield — rubble settles on it.
	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.position = ( b3Pos ){ 0.0f, groundY - 1.0f, 0.0f };
	b3BodyId ground = b3CreateBody( g_world, &bodyDef );
	b3BoxHull slab = b3MakeBoxHull( halfExtent, 1.0f, halfExtent );
	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.baseMaterial.friction = 0.85f;
	b3CreateHullShape( ground, &shapeDef, &slab.base );
}

int bx_capacity( void )
{
	return BX_MAX_BODIES;
}

int bx_alive_count( void )
{
	return g_aliveCount;
}

// Returns the slot index or -1 when full. Linear velocity + angular
// velocity seed the tumble; the cube spawns axis-aligned.
int bx_add_cube( float x, float y, float z, float hx,
				 float vx, float vy, float vz,
				 float avx, float avy, float avz )
{
	int slot = -1;
	for ( int i = 0; i < BX_MAX_BODIES; ++i )
	{
		if ( g_alive[i] == 0 )
		{
			slot = i;
			break;
		}
	}
	if ( slot < 0 || b3World_IsValid( g_world ) == false )
	{
		return -1;
	}

	b3BodyDef bodyDef = b3DefaultBodyDef();
	bodyDef.type = b3_dynamicBody;
	bodyDef.position = ( b3Pos ){ x, y, z };
	bodyDef.linearVelocity = ( b3Vec3 ){ vx, vy, vz };
	bodyDef.angularVelocity = ( b3Vec3 ){ avx, avy, avz };
	bodyDef.linearDamping = 0.08f;
	bodyDef.angularDamping = 0.12f;
	bodyDef.enableSleep = true;

	b3BodyId body = b3CreateBody( g_world, &bodyDef );
	b3BoxHull cube = b3MakeBoxHull( hx, hx, hx );
	b3ShapeDef shapeDef = b3DefaultShapeDef();
	shapeDef.baseMaterial.friction = 0.8f;
	shapeDef.baseMaterial.restitution = 0.22f;
	shapeDef.density = 1.2f;
	b3CreateHullShape( body, &shapeDef, &cube.base );

	g_bodies[slot] = body;
	g_alive[slot] = 1;
	g_aliveCount += 1;
	return slot;
}

void bx_remove( int slot )
{
	if ( slot < 0 || slot >= BX_MAX_BODIES || g_alive[slot] == 0 )
	{
		return;
	}
	b3DestroyBody( g_bodies[slot] );
	g_bodies[slot] = ( b3BodyId ){ 0, 0, 0 };
	g_alive[slot] = 0;
	g_aliveCount -= 1;
}

void bx_step( float dt, int subSteps )
{
	if ( b3World_IsValid( g_world ) == false )
	{
		return;
	}
	b3World_Step( g_world, dt, subSteps );
}

// Flat state export: 8 floats per OCCUPIED slot run, prefixed by count.
// Layout: [count, (x y z qx qy qz qw slot) * count]
float* bx_get_states( void )
{
	int w = 1;
	g_states[0] = (float)g_aliveCount;
	for ( int i = 0; i < BX_MAX_BODIES; ++i )
	{
		if ( g_alive[i] == 0 )
		{
			continue;
		}
		b3Pos p = b3Body_GetPosition( g_bodies[i] );
		b3Quat q = b3Body_GetRotation( g_bodies[i] );
		g_states[w++] = p.x;
		g_states[w++] = p.y;
		g_states[w++] = p.z;
		g_states[w++] = q.v.x;
		g_states[w++] = q.v.y;
		g_states[w++] = q.v.z;
		g_states[w++] = q.s;
		g_states[w++] = (float)i;
	}
	return g_states;
}

void bx_clear( void )
{
	for ( int i = 0; i < BX_MAX_BODIES; ++i )
	{
		if ( g_alive[i] )
		{
			b3DestroyBody( g_bodies[i] );
			g_bodies[i] = ( b3BodyId ){ 0, 0, 0 };
			g_alive[i] = 0;
		}
	}
	g_aliveCount = 0;
}
